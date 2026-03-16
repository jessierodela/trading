/**
 * config/indicators.ts
 *
 * Defines which technical indicators are enabled per asset.
 * This is the single source of truth — taapi.ts reads this at runtime
 * and only fetches what's enabled, saving credits on the free plan.
 *
 * To add/remove indicators for an asset, update the `enabled` array.
 * The dashboard UI (IndicatorSettings.tsx) also reads and writes this config
 * via the /api/indicator-config endpoint.
 *
 * Available indicators: "rsi" | "macd" | "ema50" | "ema200" | "bb" | "atr"
 */

export type IndicatorKey = "rsi" | "macd" | "ema50" | "ema200" | "bb" | "atr";

export interface AssetIndicatorConfig {
  symbol:  string;
  enabled: IndicatorKey[];
}

export const INDICATOR_LABELS: Record<IndicatorKey, string> = {
  rsi:   "RSI",
  macd:  "MACD",
  ema50: "EMA 50",
  ema200:"EMA 200",
  bb:    "Bollinger Bands",
  atr:   "ATR",
};

export const INDICATOR_DESCRIPTIONS: Record<IndicatorKey, string> = {
  rsi:   "Momentum oscillator (0–100). Overbought >70, oversold <30.",
  macd:  "Trend-following momentum. Signal line crossovers = buy/sell.",
  ema50: "50-period exponential moving average. Short-term trend.",
  ema200:"200-period exponential moving average. Long-term trend.",
  bb:    "Bollinger Bands. Price vs. volatility envelope.",
  atr:   "Average True Range. Measures volatility magnitude.",
};

// Credits cost per indicator on TAAPI free plan
export const INDICATOR_CREDITS: Record<IndicatorKey, number> = {
  rsi:   1,
  macd:  1,
  ema50: 1,
  ema200:1,
  bb:    1,
  atr:   1,
};

/**
 * Default indicator config per asset.
 * Only enable what each asset's agents actually need — fewer credits = faster cycle.
 *
 * Agents:
 *   Momentum Scout     → rsi, macd       (AAPL, NVDA, TSLA, MSFT, AMZN)
 *   Breakout Watcher   → bb              (AAPL, NVDA, SPY)
 *   Trend Follower     → ema50, ema200   (SPY, MSFT, AMZN)
 *   Crypto Ranger      → rsi, macd       (BTC, ETH, SOL, BNB)
 *   Mean Reversion     → rsi             (SOL, BNB)
 *   Volatility Arbiter → atr             (BTC, ETH)
 */
export const DEFAULT_INDICATOR_CONFIG: AssetIndicatorConfig[] = [
  { symbol: "AAPL", enabled: ["rsi", "macd", "bb"] },
  { symbol: "NVDA", enabled: ["rsi", "macd", "bb"] },
  { symbol: "TSLA", enabled: ["rsi", "macd"] },
  { symbol: "MSFT", enabled: ["rsi", "macd", "ema50", "ema200"] },
  { symbol: "AMZN", enabled: ["rsi", "macd", "ema50", "ema200"] },
  { symbol: "SPY",  enabled: ["rsi", "bb", "ema50", "ema200"] },
  { symbol: "BTC",  enabled: ["rsi", "macd", "atr"] },
  { symbol: "ETH",  enabled: ["rsi", "macd", "atr"] },
  { symbol: "SOL",  enabled: ["rsi", "macd"] },
  { symbol: "BNB",  enabled: ["rsi", "macd"] },
];

/** Helper: get enabled indicators for a symbol, falling back to rsi only */
export function getEnabledIndicators(
  symbol: string,
  config: AssetIndicatorConfig[] = DEFAULT_INDICATOR_CONFIG
): IndicatorKey[] {
  return config.find((c) => c.symbol === symbol)?.enabled ?? ["rsi"];
}

/** Helper: count total credits for a full fetch cycle */
export function totalCredits(config: AssetIndicatorConfig[]): number {
  return config.reduce((sum, asset) => sum + asset.enabled.length, 0);
}

/** Helper: estimate seconds for a full cycle on free plan (1 credit/sec + 1s buffer per asset) */
export function estimateCycleSeconds(config: AssetIndicatorConfig[]): number {
  return config.reduce((sum, asset) => sum + asset.enabled.length + 1, 0);
}