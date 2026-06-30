import type { FeatureSnapshot, Timeframe } from "@/lib/quant/types";
import {
  createDataQualityReport,
  type DataQualityIssue,
  type DataQualityReport,
  type DataQualitySeverity,
} from "./types";
import {
  closedBarAge,
  isAlignedToTimeframe,
  isClosedBarOpen,
  isValidIso,
  maxStalenessBarsFor,
} from "./freshness";
import {
  assertCompatibleMarketIdentity,
  normalizeMarketIdentity,
  type MarketIdentity,
} from "./marketIdentity";

export interface ValidateFeatureSnapshotQualityInput {
  feature: Partial<FeatureSnapshot>;
  expectedIdentity: MarketIdentity;
  timeframe: Extract<Timeframe, "1h" | "1d">;
  now: Date;
  maxStalenessBars?: number;
  checkFreshness?: boolean;
  staleSeverity?: DataQualitySeverity;
}

const NUMERIC_FIELDS: (keyof FeatureSnapshot)[] = [
  "rsi14",
  "macd",
  "macdSignal",
  "macdHist",
  "ema20",
  "ema50",
  "ema200",
  "ema20Slope",
  "ema50Slope",
  "ema200Slope",
  "atr14",
  "atrPct",
  "bbUpper",
  "bbMiddle",
  "bbLower",
  "bbWidth",
  "bbWidthPrev",
  "volumeSma20",
  "relativeVolume20",
  "distanceFromEma20Atr",
  "candleRangeAtr",
];

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteOrNull(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "number" && Number.isFinite(value));
}

export function validateFeatureSnapshotQuality(input: ValidateFeatureSnapshotQualityInput): DataQualityReport {
  const issues: DataQualityIssue[] = [];
  const feature = input.feature;
  const checkedAt = input.now.toISOString();
  const symbol = typeof feature.symbol === "string" ? feature.symbol : undefined;
  const exchange = typeof feature.exchange === "string" ? feature.exchange : undefined;
  const timeframe = typeof feature.timeframe === "string" ? feature.timeframe : input.timeframe;
  const ts = typeof feature.ts === "string" ? feature.ts : undefined;
  const staleSeverity = input.staleSeverity ?? "block";

  if (!isValidIso(feature.ts)) {
    issues.push({
      code: "FEATURE_TIMESTAMP_INVALID",
      severity: "block",
      message: "Feature timestamp must be a valid ISO timestamp.",
      symbol,
      exchange,
      timeframe,
      actual: feature.ts,
    });
  } else {
    if (!isAlignedToTimeframe(feature.ts, input.timeframe)) {
      issues.push({
        code: "FEATURE_TIMESTAMP_MISALIGNED",
        severity: "block",
        message: `Feature timestamp must align to the ${input.timeframe} source bar open timestamp.`,
        symbol,
        exchange,
        timeframe,
        ts: feature.ts,
      });
    }
    if (!isClosedBarOpen(feature.ts, input.timeframe, input.now)) {
      issues.push({
        code: "FEATURE_TIMESTAMP_INCOMPLETE",
        severity: "block",
        message: `Feature timestamp ${feature.ts} refers to a bar that is not closed.`,
        symbol,
        exchange,
        timeframe,
        ts: feature.ts,
      });
    }
    if (input.checkFreshness ?? true) {
      const age = closedBarAge(feature.ts, input.timeframe, input.now);
      const maxAge = input.maxStalenessBars ?? maxStalenessBarsFor(input.timeframe);
      if (age !== null && age > maxAge) {
        issues.push({
          code: "FEATURE_STALE",
          severity: staleSeverity,
          message: `${input.timeframe} feature is stale: age=${age} closed bars, max=${maxAge}.`,
          symbol,
          exchange,
          timeframe,
          ts: feature.ts,
          expected: { maxStalenessBars: maxAge },
          actual: { ageClosedBars: age },
        });
      }
    }
  }

  if (!finitePositive(feature.close)) {
    issues.push({
      code: "FEATURE_CLOSE_INVALID",
      severity: "block",
      message: "Feature close must be present as a finite positive number.",
      symbol,
      exchange,
      timeframe,
      ts,
      actual: feature.close,
    });
  }
  if (typeof feature.featureVersion !== "string" || feature.featureVersion.trim().length === 0) {
    issues.push({
      code: "FEATURE_VERSION_MISSING",
      severity: "block",
      message: "Feature version is required for lineage.",
      symbol,
      exchange,
      timeframe,
      ts,
    });
  }

  for (const field of NUMERIC_FIELDS) {
    const value = feature[field];
    if (!finiteOrNull(value)) {
      issues.push({
        code: "FEATURE_NUMERIC_INVALID",
        severity: "block",
        message: `Feature ${String(field)} must be finite when present.`,
        symbol,
        exchange,
        timeframe,
        ts,
        actual: { field, value },
      });
    }
  }

  if (typeof feature.rsi14 === "number" && (feature.rsi14 < 0 || feature.rsi14 > 100)) {
    issues.push({
      code: "FEATURE_RSI_OUT_OF_RANGE",
      severity: "block",
      message: `RSI must be between 0 and 100, got ${feature.rsi14}.`,
      symbol,
      exchange,
      timeframe,
      ts,
      actual: feature.rsi14,
    });
  }
  if (typeof feature.atr14 === "number" && feature.atr14 < 0) {
    issues.push({
      code: "FEATURE_ATR_NEGATIVE",
      severity: "block",
      message: "ATR must not be negative.",
      symbol,
      exchange,
      timeframe,
      ts,
      actual: feature.atr14,
    });
  }
  if (typeof feature.atrPct === "number" && feature.atrPct < 0) {
    issues.push({
      code: "FEATURE_ATR_PCT_NEGATIVE",
      severity: "block",
      message: "ATR percent must not be negative.",
      symbol,
      exchange,
      timeframe,
      ts,
      actual: feature.atrPct,
    });
  }
  if (typeof feature.candleRangeAtr === "number" && feature.candleRangeAtr < 0) {
    issues.push({
      code: "FEATURE_CANDLE_RANGE_NEGATIVE",
      severity: "block",
      message: "Candle range in ATR must not be negative.",
      symbol,
      exchange,
      timeframe,
      ts,
      actual: feature.candleRangeAtr,
    });
  }
  if (
    typeof feature.bbUpper === "number" &&
    typeof feature.bbMiddle === "number" &&
    feature.bbUpper < feature.bbMiddle
  ) {
    issues.push({
      code: "FEATURE_BB_UPPER_BELOW_MIDDLE",
      severity: "block",
      message: "Bollinger upper band is below middle band.",
      symbol,
      exchange,
      timeframe,
      ts,
      actual: { bbUpper: feature.bbUpper, bbMiddle: feature.bbMiddle },
    });
  }
  if (
    typeof feature.bbMiddle === "number" &&
    typeof feature.bbLower === "number" &&
    feature.bbMiddle < feature.bbLower
  ) {
    issues.push({
      code: "FEATURE_BB_MIDDLE_BELOW_LOWER",
      severity: "block",
      message: "Bollinger middle band is below lower band.",
      symbol,
      exchange,
      timeframe,
      ts,
      actual: { bbMiddle: feature.bbMiddle, bbLower: feature.bbLower },
    });
  }

  if (feature.symbol && feature.exchange) {
    const actualIdentity = normalizeMarketIdentity({
      symbol: String(feature.symbol),
      exchange: String(feature.exchange),
    });
    issues.push(...assertCompatibleMarketIdentity(input.expectedIdentity, actualIdentity));
  } else {
    issues.push({
      code: "FEATURE_MARKET_IDENTITY_MISSING",
      severity: "block",
      message: "Feature symbol and exchange are required for market identity checks.",
      symbol,
      exchange,
      timeframe,
      ts,
    });
  }

  if (feature.timeframe !== input.timeframe) {
    issues.push({
      code: "FEATURE_TIMEFRAME_MISMATCH",
      severity: "block",
      message: `Feature timeframe mismatch: expected ${input.timeframe}, got ${String(feature.timeframe)}.`,
      symbol,
      exchange,
      timeframe,
      ts,
      expected: input.timeframe,
      actual: feature.timeframe,
    });
  }

  return createDataQualityReport({
    scope: "feature",
    checkedAt,
    symbol,
    exchange,
    timeframe,
    issues,
  });
}

export function missingFeatureReport(input: {
  symbol: string;
  exchange: string;
  timeframe: Extract<Timeframe, "1h" | "1d">;
  now: Date;
  severity: DataQualitySeverity;
}): DataQualityReport {
  return createDataQualityReport({
    scope: "feature",
    checkedAt: input.now.toISOString(),
    symbol: input.symbol,
    exchange: input.exchange,
    timeframe: input.timeframe,
    issues: [{
      code: "FEATURE_MISSING",
      severity: input.severity,
      message: `${input.timeframe} feature snapshot is missing.`,
      symbol: input.symbol,
      exchange: input.exchange,
      timeframe: input.timeframe,
    }],
  });
}
