/**
 * lib/storage/validators.ts
 *
 * Application-level validators for storage inputs. Run before the DB sees
 * the row, so we fail fast with descriptive messages instead of waiting
 * for a Postgres constraint violation.
 *
 * These validate INVARIANTS that should hold for any caller. They do NOT
 * validate domain plausibility (e.g. "RSI 0-100"); that's the feature
 * engine's job and would mask real math bugs if forced to a clip range here.
 *
 * Conventions:
 *   - Throws ValidationError on any failure.
 *   - First failure wins — does not collect every error in a row.
 *   - Cheap. Validators are called on every insert; no I/O, no regex
 *     heroics beyond an ISO timestamp pattern.
 */
import type { Bar, FeatureSnapshot, Timeframe } from "@/lib/quant/types";

export class ValidationError extends Error {
  constructor(message: string) {
    super(`[validation] ${message}`);
    this.name = "ValidationError";
  }
}

// ─── ISO timestamp parsing ─────────────────────────────────────────────────
// Accept ISO-8601 strings with timezone designator (Z or ±hh:mm).
// Rejects timezone-less strings — ambiguous timestamps are a bug source we
// don't want at this layer.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function parseTs(ts: string, fieldName: string): Date {
  if (typeof ts !== "string" || !ISO_RE.test(ts)) {
    throw new ValidationError(
      `${fieldName} must be a UTC ISO-8601 timestamp (got: ${JSON.stringify(ts)})`
    );
  }
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`${fieldName} is not a parseable date: ${ts}`);
  }
  return d;
}

// ─── Bar-close alignment ───────────────────────────────────────────────────
// A bar's ts is the OPEN of the bar (per Bar contract). The open of a 1h bar
// must fall on the hour, a 1m bar on the minute, etc.

const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "1m":  60,
  "5m":  300,
  "15m": 900,
  "1h":  3_600,
  "1d":  86_400,
};

function assertAligned(ts: Date, timeframe: Timeframe, fieldName: string): void {
  const seconds = Math.floor(ts.getTime() / 1000);
  const interval = TIMEFRAME_SECONDS[timeframe];
  if (seconds % interval !== 0) {
    throw new ValidationError(
      `${fieldName} (${ts.toISOString()}) is not aligned to ${timeframe} boundary — ` +
      `bar open timestamps must fall exactly on the timeframe boundary`
    );
  }
  // Daily bars also require 00:00 UTC specifically (the mod check above
  // confirms second-of-day alignment, but be explicit).
  if (timeframe === "1d" && (ts.getUTCHours() !== 0 || ts.getUTCMinutes() !== 0 || ts.getUTCSeconds() !== 0)) {
    throw new ValidationError(
      `${fieldName} (${ts.toISOString()}) must be at 00:00:00 UTC for 1d bars`
    );
  }
}

// ─── Validators ────────────────────────────────────────────────────────────

export function validateBar(bar: Bar): void {
  // Required strings
  if (!bar.symbol)     throw new ValidationError("bar.symbol is required");
  if (!bar.exchange)   throw new ValidationError("bar.exchange is required");
  if (!bar.timeframe)  throw new ValidationError("bar.timeframe is required");
  if (!(bar.timeframe in TIMEFRAME_SECONDS)) {
    throw new ValidationError(`bar.timeframe must be one of 1m/5m/15m/1h/1d (got ${bar.timeframe})`);
  }

  // Timestamp
  const ts = parseTs(bar.ts, "bar.ts");
  assertAligned(ts, bar.timeframe, "bar.ts");

  // OHLC finite numbers
  for (const key of ["open", "high", "low", "close"] as const) {
    const v = bar[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ValidationError(`bar.${key} must be a finite number (got ${v})`);
    }
    if (v <= 0) {
      // Negative or zero prices don't exist on the venues we ingest.
      // Catching this here saves a Postgres round-trip and gives a clearer error.
      throw new ValidationError(`bar.${key} must be positive (got ${v})`);
    }
  }

  // OHLC sanity (matches DB check constraint but with better message)
  if (bar.high < bar.low) {
    throw new ValidationError(`bar OHLC sanity: high (${bar.high}) < low (${bar.low})`);
  }
  if (bar.high < bar.open || bar.high < bar.close) {
    throw new ValidationError(
      `bar OHLC sanity: high (${bar.high}) is below open (${bar.open}) or close (${bar.close})`
    );
  }
  if (bar.low > bar.open || bar.low > bar.close) {
    throw new ValidationError(
      `bar OHLC sanity: low (${bar.low}) is above open (${bar.open}) or close (${bar.close})`
    );
  }

  // Volume — null is OK (some sources don't expose it), negative is not.
  if (bar.volume !== null && bar.volume !== undefined) {
    if (typeof bar.volume !== "number" || !Number.isFinite(bar.volume)) {
      throw new ValidationError(`bar.volume must be a finite number or null (got ${bar.volume})`);
    }
    if (bar.volume < 0) {
      throw new ValidationError(`bar.volume must be non-negative (got ${bar.volume})`);
    }
  }
}

export function validateFeatureSnapshot(s: FeatureSnapshot): void {
  if (!s.symbol)         throw new ValidationError("feature.symbol is required");
  if (!s.exchange)       throw new ValidationError("feature.exchange is required");
  if (!s.timeframe)      throw new ValidationError("feature.timeframe is required");
  if (!(s.timeframe in TIMEFRAME_SECONDS)) {
    throw new ValidationError(`feature.timeframe must be one of 1m/5m/15m/1h/1d (got ${s.timeframe})`);
  }
  if (!s.featureVersion) throw new ValidationError("feature.featureVersion is required (lineage stamp missing)");

  const ts = parseTs(s.ts, "feature.ts");
  assertAligned(ts, s.timeframe, "feature.ts");

  if (typeof s.close !== "number" || !Number.isFinite(s.close) || s.close <= 0) {
    throw new ValidationError(`feature.close must be a positive finite number (got ${s.close})`);
  }

  // Every numeric field that's present must be finite. NaN/Infinity in
  // feature values is a math bug upstream; catching here makes it loud.
  // Allow null (concept applies but no value for this bar — e.g. EMA200 with
  // <200 bars of history).
  const numericFields: (keyof FeatureSnapshot)[] = [
    "rsi14", "macd", "macdSignal", "macdHist",
    "ema20", "ema50", "ema200",
    "ema20Slope", "ema50Slope", "ema200Slope",
    "atr14", "atrPct",
    "bbUpper", "bbMiddle", "bbLower", "bbWidth", "bbWidthPrev",
    "volumeSma20", "relativeVolume20",
    "distanceFromEma20Atr", "candleRangeAtr",
  ];

  for (const key of numericFields) {
    const v = s[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ValidationError(
        `feature.${String(key)} must be a finite number or null (got ${v})`
      );
    }
  }
}
