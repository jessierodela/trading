/**
 * config/indicators1d.ts
 *
 * Indicator config for the 1D (daily) fetch cycle.
 * Follows the same pattern as indicators.ts but scoped to daily-interval data.
 *
 * Only the Trend Follower agent reads from this config. Other agents run on 1h.
 *
 * Free plan constraints still apply — bulk endpoint available for Binance crypto.
 * Daily bars update once per day; fetching more than once per day wastes credits.
 * Manual refresh via POST /api/cache/refresh will re-fetch regardless.
 *
 * Enabled per symbol:
 *   BTC: ema50 + ema200 + candle
 *     - ema50/ema200: structural trend context on daily bars
 *     - candle: daily close (open/high/low/volume) for price location vs EMAs
 *     - prev-bar (backtrack:1): prevEma50, prevEma200 for slope + cross detection
 *   All others: disabled until validated on BTC first.
 */

import type { AssetIndicatorConfig, IndicatorKey } from "@/config/indicators";

export const DEFAULT_INDICATOR_CONFIG_1D: AssetIndicatorConfig[] = [
  { symbol: "AAPL", enabled: [] },
  { symbol: "NVDA", enabled: [] },
  { symbol: "TSLA", enabled: [] },
  { symbol: "MSFT", enabled: [] },
  { symbol: "AMZN", enabled: [] },
  { symbol: "SPY",  enabled: [] },
  { symbol: "BTC",  enabled: ["ema50", "ema200", "candle"] },
  { symbol: "ETH",  enabled: [] },
  { symbol: "SOL",  enabled: [] },
  { symbol: "BNB",  enabled: [] },
];

/** Helper: get enabled 1D indicators for a symbol */
export function getEnabledIndicators1d(symbol: string): IndicatorKey[] {
  return DEFAULT_INDICATOR_CONFIG_1D.find((c) => c.symbol === symbol)?.enabled ?? [];
}
