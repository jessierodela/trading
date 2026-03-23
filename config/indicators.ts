/**
 * config/indicators.ts
 *
 * Defines which technical indicators are enabled per asset.
 * This is the single source of truth — taapi.ts reads this at runtime
 * and only fetches what's enabled, saving credits on the free plan.
 *
 * Available indicators:
 *   "rsi" | "macd" | "ema20" | "ema50" | "ema200" | "bb" | "atr"
 *   "volumeSma20" | "candle"   ← v2 additions for volume + ATR context
 *
 * Rate-limit accounting (free plan: 1 req / 15s):
 *   Most indicators = 1 taapi call.
 *   "candle" = 2 taapi calls (current bar + prev-bar backtrack in Phase 2).
 *   INDICATOR_EXTRA_CALLS captures this so cycle estimates are accurate.
 */

export type IndicatorKey =
  | "rsi" | "macd" | "ema20" | "ema50" | "ema200" | "bb" | "atr"
  // v2: volume context + candle range
  | "volumeSma20" // taapi: volumesma, period 20 → 20-bar average volume
  | "candle";     // taapi: candle (current bar high/low/volume)
                  //        + candle backtrack:1 in Phase 2 (prev-bar volume)

export interface AssetIndicatorConfig {
  symbol:  string;
  enabled: IndicatorKey[];
}

export const INDICATOR_LABELS: Record<IndicatorKey, string> = {
  rsi:        "RSI",
  macd:       "MACD",
  ema20:      "EMA 20",
  ema50:      "EMA 50",
  ema200:     "EMA 200",
  bb:         "Bollinger Bands",
  atr:        "ATR",
  volumeSma20: "Volume SMA 20",
  candle:      "Candle (OHLCV)",
};

export const INDICATOR_DESCRIPTIONS: Record<IndicatorKey, string> = {
  rsi:        "Momentum oscillator (0–100). Overbought >70, oversold <30.",
  macd:       "Trend-following momentum. Signal line crossovers = buy/sell.",
  ema20:      "20-period EMA. Dynamic support/resistance for momentum entries.",
  ema50:      "50-period exponential moving average. Short-term trend.",
  ema200:     "200-period exponential moving average. Long-term trend.",
  bb:         "Bollinger Bands. Price vs. volatility envelope.",
  atr:        "Average True Range. Measures volatility magnitude.",
  volumeSma20: "20-bar average volume. Used to compute relativeVolume and volumeAboveAverage.",
  candle:      "Current-bar OHLCV. Provides high/low for candleRangeInAtr; prev-bar fetched for prevVolume.",
};

export const INDICATOR_CREDITS: Record<IndicatorKey, number> = {
  rsi:        1,
  macd:       1,
  ema20:      1,
  ema50:      1,
  ema200:     1,
  bb:         1,
  atr:        1,
  volumeSma20: 1,
  candle:      1, // +1 extra via INDICATOR_EXTRA_CALLS — see below
};

/**
 * Extra taapi calls consumed beyond the base indicator fetch.
 * Used by estimateCycleSeconds() to produce accurate timing estimates.
 *
 * "candle": Phase 2 in taapi.ts fetches a second candle call (backtrack: 1)
 *           to get prevVolume, so the true cost is 2 calls, not 1.
 */
export const INDICATOR_EXTRA_CALLS: Partial<Record<IndicatorKey, number>> = {
  candle: 1,
};

/**
 * DEFAULT_INDICATOR_CONFIG
 *
 * BTC (active): rsi + macd + ema20 + atr + volumeSma20 + candle
 *   = 6 base indicators + 3 Phase-2 prev-bar calls (prevRsi, prevHist, prevEma20)
 *     + 1 price call + 1 candle-backtrack call (prevVolume)
 *   = 11 taapi slots × 15.5s ≈ ~170s per full BTC cycle
 *
 * All other assets remain disabled (empty array) until validated on BTC first.
 *
 * To enable additional symbols: add indicators to their enabled[] array,
 * bump REFRESH_INTERVAL_MS in indicatorCache.ts accordingly, and re-test.
 */
export const DEFAULT_INDICATOR_CONFIG: AssetIndicatorConfig[] = [
  { symbol: "AAPL", enabled: [] },
  { symbol: "NVDA", enabled: [] },
  { symbol: "TSLA", enabled: [] },
  { symbol: "MSFT", enabled: [] },
  { symbol: "AMZN", enabled: [] },
  { symbol: "SPY",  enabled: [] },
  { symbol: "BTC",  enabled: ["rsi", "macd", "ema20", "ema50", "ema200", "atr", "volumeSma20", "candle", "bb"] },
  { symbol: "ETH",  enabled: [] },
  { symbol: "SOL",  enabled: [] },
  { symbol: "BNB",  enabled: [] },
];

/** Helper: get enabled indicators for a symbol */
export function getEnabledIndicators(
  symbol: string,
  config: AssetIndicatorConfig[] = DEFAULT_INDICATOR_CONFIG
): IndicatorKey[] {
  return config.find((c) => c.symbol === symbol)?.enabled ?? [];
}

/** Helper: count total taapi calls for a full fetch cycle (base + extra) */
export function totalCredits(config: AssetIndicatorConfig[]): number {
  return config.reduce((sum, asset) => {
    const base  = asset.enabled.length;
    const extra = asset.enabled.reduce(
      (s, k) => s + (INDICATOR_EXTRA_CALLS[k] ?? 0), 0
    );
    return sum + base + extra;
  }, 0);
}

/** Helper: estimate seconds for a full cycle on free plan (15.5s/slot) */
export function estimateCycleSeconds(config: AssetIndicatorConfig[]): number {
  // Phase-2 prev-bar fetches: rsi, macd, ema20 each add 1 call; price adds 1.
  // These are hardcoded in taapi.ts — count them separately from INDICATOR_EXTRA_CALLS.
  const PHASE2_SLOTS_PER_ASSET = 4; // prevRsi + prevHist + prevEma20 + price

  return config.reduce((sum, asset) => {
    if (asset.enabled.length === 0) return sum;
    const base  = asset.enabled.length;
    const extra = asset.enabled.reduce(
      (s, k) => s + (INDICATOR_EXTRA_CALLS[k] ?? 0), 0
    );
    return sum + (base + extra + PHASE2_SLOTS_PER_ASSET) * 15.5;
  }, 0);
}
