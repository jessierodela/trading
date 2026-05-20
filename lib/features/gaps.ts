/**
 * lib/features/gaps.ts
 *
 * Gap detection and segmentation for bar series.
 *
 * THIS IS THE SAFETY LAYER. Everything in this file enforces one
 * invariant: feature math never runs across a missing bar.
 *
 * The user's P2C requirement: "Feature engine must detect gaps and refuse
 * to calculate strategy-grade features across missing candle ranges."
 *
 * ─── Gap definition ──────────────────────────────────────────────────────
 *
 *   1h bars: every UTC hour from start to last bar must be present.
 *            13:00 then 15:00 with no 14:00 → gap.
 *
 *   1d bars: every UTC day. No market-calendar logic — BTC trades 24/7.
 *            Equity calendar awareness, if ever needed, lives in a
 *            separate module.
 *
 *   Duplicates: same timestamp twice = integrity failure, throws.
 *
 *   Misalignment: 1h not on :00, or 1d not at UTC midnight = throws with
 *                 BarAlignmentError (different class than GapDetected so
 *                 callers can tell upstream-bug from missing-data).
 *
 *   Mixed instrument: different symbol/exchange/timeframe in same array
 *                     = throws.
 *
 * ─── Why this lives separate from the engine ────────────────────────────
 *
 * The engine takes Bar[] and computes features. The gap-check happens
 * BEFORE the math touches the data. Two public entry points
 * (computeFeaturesLatest, computeFeaturesSegmented) call into this module
 * for different gap-handling strategies, then hand a guaranteed-contiguous
 * slice to the math. The math itself never sees a gap-aware code path.
 */
import type { Bar, Timeframe } from "@/lib/quant/types";

// ─── Time deltas ──────────────────────────────────────────────────────────

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m":  60 * 1_000,
  "5m":  5 * 60 * 1_000,
  "15m": 15 * 60 * 1_000,
  "1h":  60 * 60 * 1_000,
  "1d":  24 * 60 * 60 * 1_000,
};

export function expectedDeltaMs(timeframe: Timeframe): number {
  return TIMEFRAME_MS[timeframe];
}

// ─── Errors ───────────────────────────────────────────────────────────────

/**
 * Thrown when input bars violate basic invariants that should have been
 * caught upstream (validator, rollup, fetch). Different from gaps because
 * gaps are normal operational reality; these are bugs.
 */
export class BarIntegrityError extends Error {
  constructor(message: string) {
    super(`[features/gaps] integrity: ${message}`);
    this.name = "BarIntegrityError";
  }
}

/**
 * Thrown when computeFeaturesLatest is called against bars where the most
 * recent contiguous suffix is empty (no usable data at the tail). Distinct
 * class so callers can handle "I have no recent data" differently from
 * "I have bad data."
 */
export class NoUsableSuffixError extends Error {
  constructor(message: string) {
    super(`[features/gaps] no usable suffix: ${message}`);
    this.name = "NoUsableSuffixError";
  }
}

// ─── Public types ─────────────────────────────────────────────────────────

export interface Gap {
  /** Last present bar's ts before the gap. */
  beforeTs: string;
  /** First present bar's ts after the gap. */
  afterTs:  string;
  /** Number of missing bars between them. */
  missing:  number;
}

// ─── Alignment check ──────────────────────────────────────────────────────

function isAlignedToTimeframe(tsIso: string, timeframe: Timeframe): boolean {
  const ms = Date.parse(tsIso);
  if (Number.isNaN(ms)) return false;
  if (timeframe === "1d") {
    // UTC midnight: ms % 86_400_000 === 0
    return ms % TIMEFRAME_MS["1d"] === 0;
  }
  // For 1m/5m/15m/1h: the timestamp must be on a clean multiple of the
  // timeframe relative to UTC epoch midnight. Use UTC components instead
  // of a modulo against Unix epoch to be defensive against DST-like
  // surprises (irrelevant for UTC but cheap to be explicit).
  const d = new Date(ms);
  const periodSec = TIMEFRAME_MS[timeframe] / 1000;
  const secInDay = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return secInDay % periodSec === 0 && d.getUTCMilliseconds() === 0;
}

// ─── Input validation ─────────────────────────────────────────────────────

/**
 * Run pre-flight checks on a Bar[]. Throws BarIntegrityError on any
 * violation. Returns nothing; callers proceed if it doesn't throw.
 *
 * Catches the cases the user's auditor flagged:
 *   - mixed symbol/exchange/timeframe
 *   - duplicate timestamps
 *   - non-ascending order
 *   - misaligned timestamps
 *
 * Does NOT detect gaps. Gap detection is a separate pass over a validated
 * array (see findGaps below).
 */
export function validateBarSeries(bars: Bar[]): void {
  if (bars.length === 0) return;

  const head = bars[0];
  let prevTsMs: number | null = null;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];

    if (b.symbol !== head.symbol || b.exchange !== head.exchange) {
      throw new BarIntegrityError(
        `mixed symbol/exchange at index ${i}: ${b.symbol}@${b.exchange} ` +
        `vs ${head.symbol}@${head.exchange}`
      );
    }
    if (b.timeframe !== head.timeframe) {
      throw new BarIntegrityError(
        `mixed timeframe at index ${i}: ${b.timeframe} vs ${head.timeframe}`
      );
    }
    if (!isAlignedToTimeframe(b.ts, b.timeframe)) {
      throw new BarIntegrityError(
        `bar at index ${i} ts=${b.ts} is not aligned to timeframe ${b.timeframe}`
      );
    }
    const ms = Date.parse(b.ts);
    if (Number.isNaN(ms)) {
      throw new BarIntegrityError(`unparseable ts at index ${i}: ${b.ts}`);
    }
    if (prevTsMs !== null) {
      if (ms === prevTsMs) {
        throw new BarIntegrityError(`duplicate timestamp at index ${i}: ${b.ts}`);
      }
      if (ms < prevTsMs) {
        throw new BarIntegrityError(
          `non-ascending bars at index ${i}: ${b.ts} after ${new Date(prevTsMs).toISOString()}`
        );
      }
    }
    prevTsMs = ms;
  }
}

// ─── Gap finder ───────────────────────────────────────────────────────────

/**
 * Find all gaps in a validated Bar[]. Pre-requisite: validateBarSeries
 * already passed. Returns gaps in ascending order; empty array if the
 * series is fully contiguous.
 */
export function findGaps(bars: Bar[]): Gap[] {
  if (bars.length < 2) return [];
  const delta = expectedDeltaMs(bars[0].timeframe);
  const gaps: Gap[] = [];

  for (let i = 1; i < bars.length; i++) {
    const prevMs = Date.parse(bars[i - 1].ts);
    const curMs  = Date.parse(bars[i].ts);
    const observed = curMs - prevMs;
    if (observed !== delta) {
      // observed/delta should be an integer > 1 for a clean gap. If it's
      // a fractional value, that's a misalignment somewhere — but
      // validateBarSeries should have caught misalignment first. If we
      // get here with a fractional observed/delta, it means alignment
      // passed (the individual timestamps are aligned) but the spacing
      // between two aligned timestamps is non-integer multiple of delta,
      // which can't happen for proper UTC-aligned bars at the same
      // timeframe. We treat any non-1x observed as a gap.
      const missing = Math.max(0, Math.round(observed / delta) - 1);
      gaps.push({
        beforeTs: bars[i - 1].ts,
        afterTs:  bars[i].ts,
        missing,
      });
    }
  }
  return gaps;
}

// ─── Suffix extractor for computeFeaturesLatest ──────────────────────────

/**
 * Return the longest contiguous suffix of `bars` ending at the last bar.
 *
 * If the series is fully contiguous, returns a reference-equal view
 * (entire array). If there are gaps, returns the segment from the last
 * gap's `afterTs` onward.
 *
 * Throws NoUsableSuffixError if `bars` is empty. (Bars of length 1 are a
 * valid suffix of length 1.)
 */
export function longestContiguousSuffix(bars: Bar[]): Bar[] {
  if (bars.length === 0) {
    throw new NoUsableSuffixError("input bars array is empty");
  }
  const gaps = findGaps(bars);
  if (gaps.length === 0) return bars;

  // Find the index of the bar whose ts == last gap's afterTs.
  const lastGap = gaps[gaps.length - 1];
  let startIdx = -1;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].ts === lastGap.afterTs) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) {
    // Shouldn't happen — findGaps produced afterTs from this array. If it
    // does, our invariants are broken.
    throw new BarIntegrityError(
      `internal: gap afterTs=${lastGap.afterTs} not found in input bars`
    );
  }
  return bars.slice(startIdx);
}

// ─── Segmenter for computeFeaturesSegmented ──────────────────────────────

export interface BarSegment {
  startTs: string;
  endTs:   string;
  bars:    Bar[];
}

/**
 * Split `bars` into contiguous segments at every gap. Each returned
 * segment is itself fully contiguous (no gaps within).
 *
 * Empty input → empty output. Otherwise minimum one segment.
 */
export function splitIntoSegments(bars: Bar[]): BarSegment[] {
  if (bars.length === 0) return [];
  const gaps = findGaps(bars);
  if (gaps.length === 0) {
    return [{ startTs: bars[0].ts, endTs: bars[bars.length - 1].ts, bars }];
  }

  const segments: BarSegment[] = [];
  let segStartIdx = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].ts !== bars[i - 1].ts /* sanity */) {
      // Detect a gap boundary: this bar's ts != prev ts + delta.
      const delta = expectedDeltaMs(bars[0].timeframe);
      const prevMs = Date.parse(bars[i - 1].ts);
      const curMs  = Date.parse(bars[i].ts);
      if (curMs - prevMs !== delta) {
        // Close segment [segStartIdx .. i-1].
        const slice = bars.slice(segStartIdx, i);
        segments.push({
          startTs: slice[0].ts,
          endTs:   slice[slice.length - 1].ts,
          bars:    slice,
        });
        segStartIdx = i;
      }
    }
  }
  // Tail segment.
  const tail = bars.slice(segStartIdx);
  segments.push({
    startTs: tail[0].ts,
    endTs:   tail[tail.length - 1].ts,
    bars:    tail,
  });
  return segments;
}
