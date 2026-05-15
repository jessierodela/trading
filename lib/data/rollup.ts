/**
 * lib/data/rollup.ts
 *
 * Aggregate lower-timeframe bars into higher-timeframe bars.
 *
 * Used today for: 1h → 1d, so we ingest one timeframe from Coinbase REST
 * and derive the daily bars locally. The plan called this out explicitly
 * to halve API requests during backfill.
 *
 * Future: 1m → 5m, 5m → 15m, etc., when WebSocket ingestion lands. Same
 * function, different timeframe targets.
 *
 * ─── Rollup math ──────────────────────────────────────────────────────────
 *   open   = first bar's open
 *   high   = max(all highs)
 *   low    = min(all lows)
 *   close  = last bar's close
 *   volume = sum(all volumes), null if ALL inputs are null,
 *            sum-of-non-nulls otherwise (partial-null is treated as
 *            partial-data — we still emit the sum but it's an undercount).
 *
 * ─── Partial-day handling ─────────────────────────────────────────────────
 * A day with fewer than 24 hourly bars is considered partial. Default
 * behavior: emit the partial bar anyway (better than dropping data).
 * Toggle `requireFullPeriod: true` to drop partials — useful when ingesting
 * historical data where you want only fully-closed days.
 *
 * The first day of a backfill is usually partial (history started
 * mid-day); requireFullPeriod is the cleanest way to skip it.
 *
 * ─── UTC alignment ────────────────────────────────────────────────────────
 * Day boundary is UTC midnight — same as the validator's check on 1d bars.
 * This matters: a "day" in this codebase is always UTC, never local. If a
 * future caller wants exchange-local days, that's a separate function.
 */

import type { Bar, Timeframe } from "@/lib/quant/types";

// ─── Period boundary ──────────────────────────────────────────────────────

/**
 * Truncate a timestamp to the start of its UTC day.
 * Returns ISO-8601 with explicit Z suffix so the validator accepts it.
 */
function toUtcDayStart(ts: string): string {
  const d = new Date(ts);
  const dayStart = new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    0, 0, 0, 0,
  ));
  return dayStart.toISOString();
}

/** Number of source bars that constitute one full target period. */
function barsPerPeriod(sourceTf: Timeframe, targetTf: Timeframe): number {
  const seconds: Record<Timeframe, number> = {
    "1m": 60, "5m": 300, "15m": 900, "1h": 3_600, "1d": 86_400,
  };
  const ratio = seconds[targetTf] / seconds[sourceTf];
  if (!Number.isInteger(ratio) || ratio < 2) {
    throw new Error(
      `[rollup] invalid timeframe pair: ${sourceTf} → ${targetTf} ` +
      `(ratio ${ratio} must be a positive integer ≥ 2)`
    );
  }
  return ratio;
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface RollupOpts {
  /**
   * If true, drop any target period that doesn't have all expected source
   * bars. Default false — emit partial periods.
   */
  requireFullPeriod?: boolean;
}

/**
 * Aggregate `sourceBars` (ascending, same symbol/exchange/timeframe) into
 * bars at `targetTimeframe`.
 *
 * Returns ascending bars at the target timeframe. Empty input → empty output.
 *
 * Pre-conditions checked:
 *   - All source bars share symbol, exchange, timeframe.
 *   - Source timeframe divides evenly into target timeframe.
 *
 * NOT checked here (the validator handles it on the way into storage):
 *   - Each emitted bar's UTC alignment
 *   - OHLC sanity
 *   - Numeric finiteness
 */
export function rollupBars(
  sourceBars:      Bar[],
  targetTimeframe: Timeframe,
  opts:            RollupOpts = {},
): Bar[] {
  if (sourceBars.length === 0) return [];

  const sample = sourceBars[0];
  const sourceTf = sample.timeframe;
  if (sourceTf === targetTimeframe) {
    // Pass-through; no rollup needed.
    return [...sourceBars];
  }

  // Only 1d target is currently meaningful — partition function below only
  // groups by UTC day. Adding a 4h/15m target means extending partitioning.
  if (targetTimeframe !== "1d") {
    throw new Error(
      `[rollup] target timeframe ${targetTimeframe} not implemented yet ` +
      `(only 1d supported today; add a partition function for others)`
    );
  }

  const expected = barsPerPeriod(sourceTf, targetTimeframe);

  // Group by UTC day. Map preserves insertion order, which is ascending
  // since source bars are ascending.
  const byDay = new Map<string, Bar[]>();
  for (const b of sourceBars) {
    if (b.symbol !== sample.symbol || b.exchange !== sample.exchange) {
      throw new Error(
        `[rollup] mixed symbol/exchange in source bars: ` +
        `${b.symbol}@${b.exchange} vs ${sample.symbol}@${sample.exchange}`
      );
    }
    if (b.timeframe !== sourceTf) {
      throw new Error(
        `[rollup] mixed source timeframes: ${b.timeframe} vs ${sourceTf}`
      );
    }
    const dayKey = toUtcDayStart(b.ts);
    let bucket = byDay.get(dayKey);
    if (!bucket) {
      bucket = [];
      byDay.set(dayKey, bucket);
    }
    bucket.push(b);
  }

  const out: Bar[] = [];
  for (const [dayKey, bucket] of byDay) {
    if (opts.requireFullPeriod && bucket.length < expected) continue;

    // bucket is ascending because source was ascending and we iterate in order.
    const open  = bucket[0].open;
    const close = bucket[bucket.length - 1].close;
    let   high  = bucket[0].high;
    let   low   = bucket[0].low;
    let   volume: number | null = null;
    let   anyVolume = false;

    for (const b of bucket) {
      if (b.high > high) high = b.high;
      if (b.low  < low)  low  = b.low;
      if (b.volume !== null && b.volume !== undefined) {
        anyVolume = true;
        volume = (volume ?? 0) + b.volume;
      }
    }
    if (!anyVolume) volume = null;

    out.push({
      symbol:     sample.symbol,
      exchange:   sample.exchange,
      timeframe:  targetTimeframe,
      ts:         dayKey,
      open, high, low, close, volume,
      tradeCount: null,
    });
  }

  return out;
}