import type { Bar, Timeframe } from "@/lib/quant/types";
import {
  createDataQualityReport,
  type DataQualityIssue,
  type DataQualityReport,
} from "./types";
import {
  isAlignedToTimeframe,
  isClosedBarOpen,
  isValidIso,
} from "./freshness";
import {
  assertCompatibleMarketIdentity,
  normalizeMarketIdentity,
  type MarketDataSource,
  type MarketIdentity,
} from "./marketIdentity";

export type VolumePolicy = "required" | "optional_unavailable" | "ignore";

export interface ValidateBarQualityInput {
  bar: Partial<Bar>;
  expectedIdentity: MarketIdentity;
  timeframe: Extract<Timeframe, "1h" | "1d">;
  now: Date;
  closedBarsOnly: boolean;
  volumePolicy: VolumePolicy;
  source?: MarketDataSource;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validateBarQuality(input: ValidateBarQualityInput): DataQualityReport {
  const issues: DataQualityIssue[] = [];
  const bar = input.bar;
  const checkedAt = input.now.toISOString();
  const symbol = typeof bar.symbol === "string" ? bar.symbol : undefined;
  const exchange = typeof bar.exchange === "string" ? bar.exchange : undefined;
  const timeframe = typeof bar.timeframe === "string" ? bar.timeframe : input.timeframe;
  const ts = typeof bar.ts === "string" ? bar.ts : undefined;

  if (!isValidIso(bar.ts)) {
    issues.push({
      code: "BAR_TIMESTAMP_INVALID",
      severity: "block",
      message: "Bar timestamp must be a valid ISO timestamp.",
      symbol,
      exchange,
      source: input.source,
      timeframe,
      actual: bar.ts,
    });
  } else {
    if (!isAlignedToTimeframe(bar.ts, input.timeframe)) {
      issues.push({
        code: "BAR_TIMESTAMP_MISALIGNED",
        severity: "block",
        message: `Bar timestamp must be aligned to the ${input.timeframe} open boundary.`,
        symbol,
        exchange,
        source: input.source,
        timeframe,
        ts: bar.ts,
      });
    }
    if (input.closedBarsOnly && !isClosedBarOpen(bar.ts, input.timeframe, input.now)) {
      issues.push({
        code: "BAR_INCOMPLETE",
        severity: "block",
        message: `Bar ${bar.ts} is not closed for timeframe ${input.timeframe}.`,
        symbol,
        exchange,
        source: input.source,
        timeframe,
        ts: bar.ts,
      });
    }
  }

  for (const key of ["open", "high", "low", "close"] as const) {
    if (!finitePositive(bar[key])) {
      issues.push({
        code: `BAR_${key.toUpperCase()}_INVALID`,
        severity: "block",
        message: `Bar ${key} must be present as a finite positive number.`,
        symbol,
        exchange,
        source: input.source,
        timeframe,
        ts,
        actual: bar[key],
      });
    }
  }

  if (finitePositive(bar.high) && finitePositive(bar.low) && bar.high < bar.low) {
    issues.push({
      code: "BAR_HIGH_BELOW_LOW",
      severity: "block",
      message: `Bar high ${bar.high} is below low ${bar.low}.`,
      symbol,
      exchange,
      source: input.source,
      timeframe,
      ts,
      actual: { high: bar.high, low: bar.low },
    });
  }
  if (finitePositive(bar.open) && finitePositive(bar.high) && finitePositive(bar.low) && (bar.open > bar.high || bar.open < bar.low)) {
    issues.push({
      code: "BAR_OPEN_OUTSIDE_RANGE",
      severity: "block",
      message: `Bar open ${bar.open} is outside high/low range ${bar.low}-${bar.high}.`,
      symbol,
      exchange,
      source: input.source,
      timeframe,
      ts,
      actual: { open: bar.open, high: bar.high, low: bar.low },
    });
  }
  if (finitePositive(bar.close) && finitePositive(bar.high) && finitePositive(bar.low) && (bar.close > bar.high || bar.close < bar.low)) {
    issues.push({
      code: "BAR_CLOSE_OUTSIDE_RANGE",
      severity: "block",
      message: `Bar close ${bar.close} is outside high/low range ${bar.low}-${bar.high}.`,
      symbol,
      exchange,
      source: input.source,
      timeframe,
      ts,
      actual: { close: bar.close, high: bar.high, low: bar.low },
    });
  }

  if (bar.volume === null || bar.volume === undefined) {
    if (input.volumePolicy === "required") {
      issues.push({
        code: "BAR_VOLUME_MISSING",
        severity: "block",
        message: "Bar volume is required and must not be silently treated as zero.",
        symbol,
        exchange,
        source: input.source,
        timeframe,
        ts,
      });
    } else if (input.volumePolicy === "optional_unavailable") {
      issues.push({
        code: "BAR_VOLUME_UNAVAILABLE",
        severity: "warn",
        message: "Bar volume is unavailable and explicitly marked optional.",
        symbol,
        exchange,
        source: input.source,
        timeframe,
        ts,
      });
    }
  } else if (typeof bar.volume !== "number" || !Number.isFinite(bar.volume) || bar.volume < 0) {
    issues.push({
      code: "BAR_VOLUME_INVALID",
      severity: "block",
      message: "Bar volume must be finite and non-negative when present.",
      symbol,
      exchange,
      source: input.source,
      timeframe,
      ts,
      actual: bar.volume,
    });
  }

  if (bar.symbol && bar.exchange) {
    const actualIdentity = normalizeMarketIdentity({
      symbol: String(bar.symbol),
      exchange: String(bar.exchange),
      source: input.source,
    });
    issues.push(...assertCompatibleMarketIdentity(input.expectedIdentity, actualIdentity));
  } else {
    issues.push({
      code: "BAR_MARKET_IDENTITY_MISSING",
      severity: "block",
      message: "Bar symbol and exchange are required for market identity checks.",
      symbol,
      exchange,
      source: input.source,
      timeframe,
      ts,
    });
  }

  if (bar.timeframe !== input.timeframe) {
    issues.push({
      code: "BAR_TIMEFRAME_MISMATCH",
      severity: "block",
      message: `Bar timeframe mismatch: expected ${input.timeframe}, got ${String(bar.timeframe)}.`,
      symbol,
      exchange,
      source: input.source,
      timeframe,
      ts,
      expected: input.timeframe,
      actual: bar.timeframe,
    });
  }

  return createDataQualityReport({
    scope: "bar",
    checkedAt,
    symbol,
    exchange,
    source: input.source,
    timeframe,
    issues,
  });
}
