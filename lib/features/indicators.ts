/**
 * lib/features/indicators.ts
 *
 * Streaming indicator primitives. Each indicator is a closure that
 * remembers its own state and returns either a value or null (while
 * warming up). Reset for a new segment by constructing a fresh instance.
 *
 * Why streaming, not batch:
 *   - Per-indicator warmup ("rsi14 null until 14 bars, ema200 null until
 *     200, row still emitted") falls out for free — the indicator itself
 *     returns null until it's ready, no orchestrator logic.
 *   - Segment boundaries are trivial: discard the old instances, build
 *     new ones. State cannot leak across a gap by construction.
 *   - Determinism: each indicator's state is local. Same input sequence
 *     → same output sequence, bit-identical, no shared mutable state.
 *
 * What "warmup satisfied" means per indicator:
 *
 *   EMA(n):   First value emitted at bar n-1 (zero-indexed), seeded with
 *             the SMA of the first n closes. Wilder-style alpha is NOT
 *             used here — EMA uses standard alpha = 2/(n+1). Wilder's
 *             alpha applies to RSI and ATR only (see below).
 *
 *   RSI(14): Uses Wilder's smoothing (alpha = 1/14). First value emitted
 *             at bar 14, using the simple average of the first 14 gains
 *             and losses, then Wilder-smoothed thereafter.
 *
 *   ATR(14): Uses Wilder's smoothing. First value emitted at bar 14
 *             (need 14 TR values; first TR is at bar 1 since it needs
 *             a previous close). Seeded with the simple average of
 *             the first 14 TRs, then Wilder-smoothed.
 *
 *   MACD:    EMA12 - EMA26. macd itself becomes non-null at bar 25.
 *            macdSignal = EMA9 of macd; becomes non-null 8 bars after
 *            macd first becomes non-null, i.e., bar 33. macdHist =
 *            macd - macdSignal, same warmup as macdSignal.
 *
 *   BB(20):  Middle = SMA20. Upper/lower = ±2 stdev. Non-null at bar 19.
 *            stdev uses population (N), not sample (N-1) — TradingView
 *            and TAAPI both use population.
 *
 *   SMA(n): Trivial. Non-null at bar n-1.
 *
 * Determinism notes:
 *   - No Math.random. No Date.now.
 *   - Iteration order is array index — deterministic.
 *   - No floating-point operations whose order changes between runs.
 *   - Map/Set are used for unrelated bookkeeping, never for math ordering.
 */

// ─── EMA ──────────────────────────────────────────────────────────────────

/**
 * Standard exponential moving average with seed = SMA of first `period`
 * values. Returns null until `period` values have been fed in.
 *
 * alpha = 2 / (period + 1) — the textbook "EMA" alpha. Different from
 * Wilder's alpha (which is 1/period and applies to RSI/ATR).
 */
export function createEma(period: number): (value: number) => number | null {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`[ema] period must be a positive integer, got ${period}`);
  }
  const alpha = 2 / (period + 1);
  const seedBuf: number[] = [];
  let value: number | null = null;

  return (x: number) => {
    if (value === null) {
      seedBuf.push(x);
      if (seedBuf.length < period) return null;
      // Seed with SMA. Equivalent to TAAPI's default.
      let sum = 0;
      for (let i = 0; i < seedBuf.length; i++) sum += seedBuf[i];
      value = sum / period;
      return value;
    }
    value = alpha * x + (1 - alpha) * value;
    return value;
  };
}

// ─── SMA ──────────────────────────────────────────────────────────────────

/** Simple moving average over the last `period` values. */
export function createSma(period: number): (value: number) => number | null {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`[sma] period must be a positive integer, got ${period}`);
  }
  const window: number[] = [];
  let sum = 0;

  return (x: number) => {
    window.push(x);
    sum += x;
    if (window.length > period) {
      sum -= window.shift()!;
    }
    if (window.length < period) return null;
    return sum / period;
  };
}

// ─── RSI (Wilder) ─────────────────────────────────────────────────────────

/**
 * Wilder's RSI. First value emitted at bar `period` (i.e., need `period`
 * gain/loss diffs, which require `period + 1` closes).
 *
 * Initial avg gain/loss = simple average of first `period` gains/losses.
 * Subsequent: Wilder's smoothing = ((prev_avg * (period-1)) + cur) / period.
 *
 * Returns null during warmup; returns the RSI [0,100] thereafter.
 */
export function createRsi(period: number): (close: number) => number | null {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`[rsi] period must be a positive integer, got ${period}`);
  }
  let prevClose: number | null = null;
  const initGains:  number[] = [];
  const initLosses: number[] = [];
  let avgGain: number | null = null;
  let avgLoss: number | null = null;

  return (close: number) => {
    if (prevClose === null) {
      prevClose = close;
      return null;
    }
    const change = close - prevClose;
    const gain = change > 0 ?  change : 0;
    const loss = change < 0 ? -change : 0;
    prevClose = close;

    if (avgGain === null) {
      initGains.push(gain);
      initLosses.push(loss);
      if (initGains.length < period) return null;
      // Seed.
      let gSum = 0, lSum = 0;
      for (let i = 0; i < period; i++) {
        gSum += initGains[i];
        lSum += initLosses[i];
      }
      avgGain = gSum / period;
      avgLoss = lSum / period;
    } else {
      // Wilder smoothing.
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss! * (period - 1) + loss) / period;
    }

    if (avgGain === 0 && avgLoss === 0) return 50;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  };
}

// ─── ATR (Wilder) ─────────────────────────────────────────────────────────

/**
 * Wilder's Average True Range. Returns null until `period` TRs have been
 * accumulated (need `period + 1` bars total since TR at bar 0 is
 * undefined — no prior close).
 *
 * TR = max(high - low, |high - prevClose|, |low - prevClose|).
 *
 * Seed = simple average of first `period` TRs.
 * Then: atr_t = (atr_{t-1} * (period-1) + tr_t) / period.
 */
export function createAtr(period: number): (h: number, l: number, c: number) => number | null {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`[atr] period must be a positive integer, got ${period}`);
  }
  let prevClose: number | null = null;
  const initTr: number[] = [];
  let atr: number | null = null;

  return (high: number, low: number, close: number) => {
    if (prevClose === null) {
      prevClose = close;
      return null;
    }
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low  - prevClose),
    );
    prevClose = close;

    if (atr === null) {
      initTr.push(tr);
      if (initTr.length < period) return null;
      let sum = 0;
      for (let i = 0; i < period; i++) sum += initTr[i];
      atr = sum / period;
      return atr;
    }
    atr = (atr * (period - 1) + tr) / period;
    return atr;
  };
}

// ─── MACD ─────────────────────────────────────────────────────────────────

export interface MacdValue {
  macd:        number;
  macdSignal:  number;
  macdHist:    number;
}

/**
 * MACD = EMA(fast) - EMA(slow), signal = EMA(signalPeriod) of MACD,
 * hist = MACD - signal.
 *
 * Returns null during warmup of any component.
 *
 * Standard config: fast=12, slow=26, signal=9.
 */
export function createMacd(
  fastPeriod   = 12,
  slowPeriod   = 26,
  signalPeriod = 9,
): (close: number) => MacdValue | null {
  if (fastPeriod >= slowPeriod) {
    throw new Error(`[macd] fast (${fastPeriod}) must be < slow (${slowPeriod})`);
  }
  const fastEma   = createEma(fastPeriod);
  const slowEma   = createEma(slowPeriod);
  const signalEma = createEma(signalPeriod);

  return (close: number) => {
    const fast = fastEma(close);
    const slow = slowEma(close);
    if (fast === null || slow === null) return null;
    const macd = fast - slow;
    const sig  = signalEma(macd);
    if (sig === null) return null;
    return { macd, macdSignal: sig, macdHist: macd - sig };
  };
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────

export interface BbValue {
  bbUpper:  number;
  bbMiddle: number;
  bbLower:  number;
}

/**
 * Bollinger Bands. Middle = SMA(period). Upper/lower = ± stdDevs * sigma,
 * where sigma is the POPULATION stdev of the last `period` closes.
 *
 * (TradingView and TAAPI both use population stdev. Sample stdev gives
 * slightly different numbers and would diverge from cross-validation.)
 *
 * Standard: period=20, stdDevs=2.
 */
export function createBb(
  period:  number = 20,
  stdDevs: number = 2,
): (close: number) => BbValue | null {
  if (!Number.isInteger(period) || period < 2) {
    throw new Error(`[bb] period must be >= 2, got ${period}`);
  }
  const window: number[] = [];

  return (close: number) => {
    window.push(close);
    if (window.length > period) window.shift();
    if (window.length < period) return null;

    let sum = 0;
    for (let i = 0; i < period; i++) sum += window[i];
    const mean = sum / period;

    let varSum = 0;
    for (let i = 0; i < period; i++) {
      const d = window[i] - mean;
      varSum += d * d;
    }
    // Population stdev. Population, not sample — matches TradingView/TAAPI.
    const sigma = Math.sqrt(varSum / period);
    return {
      bbMiddle: mean,
      bbUpper:  mean + stdDevs * sigma,
      bbLower:  mean - stdDevs * sigma,
    };
  };
}
