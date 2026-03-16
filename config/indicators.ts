/**
 * config/indicators.ts
 *
 * Defines which technical indicators are enabled per asset.
 * This is the single source of truth — taapi.ts reads this at runtime
 * and only fetches what's enabled, saving credits on the free plan.
 *
 * Available indicators: "rsi" | "macd" | "ema20" | "ema50" | "ema200" | "bb" | "atr"
 */

export type IndicatorKey = "rsi" | "macd" | "ema20" | "ema50" | "ema200" | "bb" | "atr";

export interface AssetIndicatorConfig {
  symbol:  string;
  enabled: IndicatorKey[];
}

export const INDICATOR_LABELS: Record<IndicatorKey, string> = {
  rsi:    "RSI",
  macd:   "MACD",
  ema20:  "EMA 20",
  ema50:  "EMA 50",
  ema200: "EMA 200",
  bb:     "Bollinger Bands",
  atr:    "ATR",
};

export const INDICATOR_DESCRIPTIONS: Record<IndicatorKey, string> = {
  rsi:    "Momentum oscillator (0–100). Overbought >70, oversold <30.",
  macd:   "Trend-following momentum. Signal line crossovers = buy/sell.",
  ema20:  "20-period EMA. Dynamic support/resistance for momentum entries.",
  ema50:  "50-period exponential moving average. Short-term trend.",
  ema200: "200-period exponential moving average. Long-term trend.",
  bb:     "Bollinger Bands. Price vs. volatility envelope.",
  atr:    "Average True Range. Measures volatility magnitude.",
};

export const INDICATOR_CREDITS: Record<IndicatorKey, number> = {
  rsi:    1,
  macd:   1,
  ema20:  1,
  ema50:  1,
  ema200: 1,
  bb:     1,
  atr:    1,
};

/**
 * BTC: rsi + macd + ema20 + atr = 4 credits/cycle (~62s on free plan)
 * ema20 added to power Momentum Scout's three-condition structure:
 *   Bullish continuation, Pullback entry, Reversal warning.
 */
export const DEFAULT_INDICATOR_CONFIG: AssetIndicatorConfig[] = [
  { symbol: "AAPL", enabled: [] },
  { symbol: "NVDA", enabled: [] },
  { symbol: "TSLA", enabled: [] },
  { symbol: "MSFT", enabled: [] },
  { symbol: "AMZN", enabled: [] },
  { symbol: "SPY",  enabled: [] },
  { symbol: "BTC",  enabled: ["rsi", "macd", "ema20", "atr"] },
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

/** Helper: count total credits for a full fetch cycle */
export function totalCredits(config: AssetIndicatorConfig[]): number {
  return config.reduce((sum, asset) => sum + asset.enabled.length, 0);
}

/** Helper: estimate seconds for a full cycle on free plan */
export function estimateCycleSeconds(config: AssetIndicatorConfig[]): number {
  return config.reduce((sum, asset) => sum + asset.enabled.length + 1, 0);
}
