// Trend bot for btc-race-24h-20261123-0511: trades Coinbase Wrapped BTC (cbBTC) vs USDC
// on 1-minute bars, long only, $1,000 paper money, protocol agent-fun/bars-replay/v1.
//
// Why this shape (measured on the dev window with the kit harness, not fitted to it):
// a fill costs ~46 bps round-trip at full size (4 bps fee + 2 bps slippage + ~17 bps
// of pool impact each way against ~$0.6M of depth), so 1-minute noise is untradable
// and every exit + re-entry must clear that bar. The dev window is one strong rally
// followed by flat chop: EMA-cross and breakout bots churned 10-76 trades and lost
// money, while buying the trend early and holding made ~$32. So this bot trades
// rarely and only with the trend behind it:
//
//   - Entry: the 15-bar return tops 20 bps AND the close sits above EMA(48) AND
//     EMA(12) sits above EMA(48), i.e. a genuine uptick inside a rising uptrend,
//     not a wiggle in chop.
//   - Exit: a 2% trailing stop off the best close since entry (a crash guard), or a
//     10% equity drawdown from the peak (far inside the race window's 25% guardrail).
//     There is deliberately no EMA-cross exit: on the dev window it whipsawed 22-28
//     trades and turned +$32 into -$25.
//   - Size: the whole cash balance, capped by the weight cap; one position at a time.
//   - Flat bars (close unchanged) carry no signal and are never traded on.
//
// Fully deterministic: float64 EMAs seeded as the mean of their first span of closes,
// no randomness, no wall clock, no network, no files. The same bars give the same
// orders, run after run.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** The lookback for the entry momentum: the close now vs 15 bars back. */
const MOM_LOOKBACK = 15;
/** Entry needs a 15-bar return above 20 bps (0.002). */
const MOM_THR = 0.002;
/** The slow trend filter: the close must sit above this EMA to enter. */
const SLOW_BARS = 48;
/** The fast EMA: it must sit above the slow one, so the trend is rising, not just high. */
const FAST_BARS = 12;
/** A 2% trailing stop off the best close since entry. */
const TRAIL_PCT = 0.02;
/** Flatten if equity falls 10% from its peak. */
const DD_GUARD_PCT = 0.10;
/** Never pay more than 1% past the close an order was decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

/** Per-symbol trend state. */
interface Series {
  fast: Ema;
  slow: Ema;
  /** Every close so far, in batch order. */
  closes: number[];
  /** Best close since the current entry (0 while flat). */
  peak: number;
  /** The previous bar's close, or null before the first bar. */
  prevClose: number | null;
}

const series = new Map<string, Series>();

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { fast: { span: FAST_BARS, warm: [], value: null }, slow: { span: SLOW_BARS, warm: [], value: null }, closes: [], peak: 0, prevClose: null };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  s.prevClose = s.closes.length > 0 ? s.closes[s.closes.length - 1] : null;
  s.closes.push(c);
  step(s.fast, c);
  step(s.slow, c);
  if (s.peak > 0 && c > s.peak) s.peak = c;
  return s;
}

/** The 15-bar return ending at the latest close, or null without the history. */
function momentum(s: Series): number | null {
  const n = s.closes.length;
  if (n <= MOM_LOOKBACK) return null;
  const now = s.closes[n - 1];
  const then = s.closes[n - 1 - MOM_LOOKBACK];
  if (then === 0) return null;
  return now / then - 1;
}

/** The highest equity seen so far (marked at each batch's closes). */
let peakEquity = 0n;

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      push(bar);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];
    if (state.equity > peakEquity) peakEquity = state.equity;

    const { caps, fees } = state.hello;
    const orders: (SellInput | BuyInput)[] = [];

    // Exits first: one held position at most, flattened whole.
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      if (held === undefined) continue;
      const s = series.get(symbol)!;
      const close = s.closes[s.closes.length - 1];
      const trailHit = s.peak > 0 && close < s.peak * (1 - TRAIL_PCT);
      const ddHit = peakEquity > 0n && state.equity * 10n < peakEquity * 9n;
      if (trailHit || ddHit) {
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    if (orders.length > 0) return orders.slice(0, caps.max_orders_per_bar);

    // Entries: only while flat, only on a bar that actually moved.
    if (state.positions.size >= caps.max_open_positions) return [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const n = s.closes.length;
      if (n === 0) continue;
      const close = s.closes[n - 1];
      if (s.prevClose !== null && close === s.prevClose) continue;
      const m = momentum(s);
      if (m === null || m <= MOM_THR) continue;
      if (s.slow.value === null || s.fast.value === null) continue;
      if (close < s.slow.value || s.fast.value < s.slow.value) continue;
      const room = state.weightRoom(symbol);
      let slice = state.cash < room ? state.cash : room;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      series.get(symbol)!.peak = close;
      break;
    }
    return orders.slice(0, caps.max_orders_per_bar);
  },
});
