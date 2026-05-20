/**
 * lib/features/crossValidate.ts
 *
 * P2D — Feature engine cross-validation core. PURE module: no DB, no
 * network, no Date.now, no Math.random. Same inputs → identical report.
 *
 * Framing (auditor-mandated — do not deviate):
 *   P2D proves the local engine is internally deterministic and
 *   mathematically consistent, then uses TAAPI as an external cross-venue
 *   sanity check before the live cutover.
 *
 * Our bars are Coinbase BTC-USD; TAAPI free plan is Binance BTC/USDT.
 * Different venues. Perfect mathematical parity is NOT expected and is not
 * claimed anywhere. TAAPI is a ballpark sanity check, not ground truth.
 *
 * This file contains three pieces:
 *
 *   1. crossValidate()              — compares local features against TAAPI
 *                                      reference values, indicator-specific
 *                                      tolerances, hard/soft classification.
 *   2. validateVolumeInternally()   — recomputes volumeSma20 / relativeVolume20
 *                                      a second, naive way and asserts the
 *                                      engine agrees. (Volume is venue-specific,
 *                                      never compared to TAAPI.)
 *   3. validateBollingerInternally()— recomputes Bollinger Bands naively
 *                                      (SMA20 ± 2·population stdev) and asserts
 *                                      the engine agrees. Stdev bugs are easy
 *                                      to miss; this proves self-consistency
 *                                      independent of the TAAPI ballpark check.
 */
import type { Bar, FeatureSnapshot, Timeframe } from "@/lib/quant/types";

// ─── Indicators compared against TAAPI ──────────────────────────────────────
// Price-derived only. Volume is NEVER compared cross-venue (see §Q2). Sorted
// is irrelevant for membership but we iterate a fixed sorted order elsewhere
// for determinism.

export const COMPARED_INDICATORS = [
  "rsi14",
  "macd",
  "macdSignal",
  "macdHist",
  "ema20",
  "ema50",
  "ema200",
  "atr14",
  "bbUpper",
  "bbMiddle",
  "bbLower",
] as const;

export type ComparedIndicator = (typeof COMPARED_INDICATORS)[number];

// ─── Tolerance config (auditor-locked — implement exactly) ──────────────────
//
// Raw percent deviation is banned as the sole method: indicators near zero
// (MACD, ATR in calm markets) make percent error explode meaninglessly.
//
//   maxAbsPctOfPrice : abs(local - reference) / localClose          <= threshold
//   maxAbsPoints     : abs(local - reference)                       <= threshold (raw units)
//   maxRelativePct   : abs(local - reference) / abs(reference)      <= threshold
//                      Only applied when abs(reference) is large enough to be
//                      stable; below RELATIVE_EPS we skip it and rely on
//                      maxAbsPctOfPrice (guards divide-by-near-zero).
//   reportSignMismatch: if sign(local) != sign(reference), surface a soft
//                      finding (not an automatic hard failure).

export interface Tolerance {
  maxAbsPctOfPrice?:   number;
  maxAbsPoints?:       number;
  maxRelativePct?:     number;
  reportSignMismatch?: boolean;
}

export type ToleranceConfig = Record<string, Tolerance>;

export const TOLERANCES: ToleranceConfig = {
  // Price-level indicators: deviation as a % of BTC close price,
  // NOT as a % of the indicator value.
  ema20:  { maxAbsPctOfPrice: 0.005 },
  ema50:  { maxAbsPctOfPrice: 0.005 },
  ema200: { maxAbsPctOfPrice: 0.0075 },   // looser: long warmup + venue drift

  bbUpper:  { maxAbsPctOfPrice: 0.0075 },
  bbMiddle: { maxAbsPctOfPrice: 0.005 },
  bbLower:  { maxAbsPctOfPrice: 0.0075 },

  // Oscillator: absolute points (it's already 0–100).
  rsi14: { maxAbsPoints: 2.0 },

  // Range indicator: normalized to price, plus a relative band. A bar passes
  // if EITHER the price-normalized bound OR the relative bound holds — venue
  // volatility differs more than price levels do, so the relative band is an
  // alternative acceptance, not an additional gate.
  atr14: { maxAbsPctOfPrice: 0.003, maxRelativePct: 0.10 },

  // MACD family: normalize to BTC price (values can be near zero).
  macd:       { maxAbsPctOfPrice: 0.0025 },
  macdSignal: { maxAbsPctOfPrice: 0.0025 },
  macdHist:   { maxAbsPctOfPrice: 0.0025, reportSignMismatch: true },
};

/** Below this absolute reference magnitude, the relative-pct check is skipped. */
const RELATIVE_EPS = 1e-6;

/**
 * Systematic-failure cutoff. If more than this fraction of a single
 * indicator's sampled bars fail tolerance, the whole indicator is treated as
 * a systematic (hard) failure regardless of any individual bar's softness.
 * An indicator failing on one or two scattered bars (with the rest clean) is
 * an isolated cross-venue outlier → soft.
 */
const SYSTEMATIC_FAILURE_FRACTION = 0.10;

/** Internal naive-recompute tolerance — same machine, same math, only float
 *  ordering differs, so this is tight. */
const INTERNAL_ABS_EPS = 1e-6;

// ─── Report shapes ──────────────────────────────────────────────────────────

export type Severity = "pass" | "soft" | "hard";

export interface IndicatorDiff {
  ts:             string;
  indicator:      string;
  localValue:     number | null;
  referenceValue: number | null;
  close?:         number;
  absDiff?:       number;
  pctOfPrice?:    number;
  relativePct?:   number;
  absPoints?:     number;
  /** Did the numeric tolerance hold? Structural problems (missing/null) are false. */
  passed:         boolean;
  severity:       Severity;
  reason?:        string;
}

export interface IndicatorSummary {
  indicator:    string;
  sampledBars:  number;
  passed:       number;
  softFindings: number;
  hardFailures: number;
  toleranceUsed: string;        // human-readable
  worstAbsDiff:  number;
  worstBarTs:    string;
}

export interface CrossValidationReport {
  symbol:            string;
  localExchange:     string;
  referenceExchange: string;
  timeframe:         Timeframe;
  featureVersion:    string;
  sampleStartTs:     string;
  sampleEndTs:       string;
  sampledBars:       number;
  indicatorSummaries: IndicatorSummary[];
  diffs:             IndicatorDiff[];
  hardFailures:      IndicatorDiff[];
  softFindings:      IndicatorDiff[];
  /** true iff hardFailures.length === 0. */
  passed:            boolean;
}

export type TaapiRefValues = Partial<Record<ComparedIndicator, number | null>>;

export interface CrossValidateMeta {
  symbol?:            string;
  localExchange?:     string;
  referenceExchange?: string;
  timeframe?:         Timeframe;
  featureVersion?:    string;
}

export interface InternalCheckFailure {
  ts:        string;
  field:     string;
  engine:    number | null;
  naive:     number | null;
  absDiff?:  number;
  reason:    string;
}

export interface InternalCheckResult {
  name:     string;
  checked:  number;     // bars where a comparison was made
  passed:   number;
  failures: InternalCheckFailure[];
  ok:       boolean;    // failures.length === 0
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function humanTolerance(t: Tolerance): string {
  const parts: string[] = [];
  if (t.maxAbsPctOfPrice !== undefined) parts.push(`${(t.maxAbsPctOfPrice * 100).toFixed(4)}% of price`);
  if (t.maxAbsPoints !== undefined)     parts.push(`${t.maxAbsPoints} points`);
  if (t.maxRelativePct !== undefined)   parts.push(`${(t.maxRelativePct * 100).toFixed(2)}% relative`);
  return parts.join(" or ") || "(none)";
}

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

// ─── crossValidate ──────────────────────────────────────────────────────────

/**
 * Compare local features against TAAPI reference values.
 *
 * @param localFeatures  the SAMPLED window only (already trimmed past warmup).
 * @param taapiReference reference values keyed by candle ts (ISO-8601).
 * @param tolerances     the TOLERANCES config (passed explicitly for testability).
 * @param meta           symbol/exchange/timeframe/version for the report header.
 *
 * Determinism: timestamps are processed in sorted order; indicators in the
 * fixed COMPARED_INDICATORS order. No Map-iteration-order dependence.
 */
export function crossValidate(
  localFeatures: FeatureSnapshot[],
  taapiReference: Record<string, TaapiRefValues>,
  tolerances: ToleranceConfig = TOLERANCES,
  meta: CrossValidateMeta = {},
): CrossValidationReport {
  // Index local rows by ts for O(1) lookup; build a deterministic sorted ts list.
  const localByTs = new Map<string, FeatureSnapshot>();
  for (const f of localFeatures) localByTs.set(f.ts, f);

  const sampleTimestamps = localFeatures
    .map((f) => f.ts)
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const diffs: IndicatorDiff[] = [];

  for (const indicator of COMPARED_INDICATORS) {
    const tol = tolerances[indicator];
    if (!tol) continue; // indicator not configured for comparison

    for (const ts of sampleTimestamps) {
      const local = localByTs.get(ts);
      const ref   = taapiReference[ts];

      // ── Structural hard failures ────────────────────────────────────────
      if (!local) {
        diffs.push({
          ts, indicator, localValue: null, referenceValue: null,
          passed: false, severity: "hard",
          reason: "missing local feature row for sampled timestamp",
        });
        continue;
      }
      const localValue = (local[indicator] ?? null) as number | null;
      const referenceValue = (ref ? ref[indicator] ?? null : null);

      if (!ref || referenceValue === null || referenceValue === undefined) {
        diffs.push({
          ts, indicator, localValue, referenceValue: null,
          close: local.close,
          passed: false, severity: "hard",
          reason: "missing TAAPI reference value for sampled timestamp",
        });
        continue;
      }
      if (localValue === null) {
        // Sampled window is past warmup; a null local here is a real problem.
        diffs.push({
          ts, indicator, localValue: null, referenceValue,
          close: local.close,
          passed: false, severity: "hard",
          reason: "null local value where warmup should be complete",
        });
        continue;
      }

      // ── Numeric tolerance evaluation ────────────────────────────────────
      const close = local.close;
      const absDiff = Math.abs(localValue - referenceValue);
      const pctOfPrice = close !== 0 ? absDiff / Math.abs(close) : Infinity;
      const relApplicable = Math.abs(referenceValue) >= RELATIVE_EPS;
      const relativePct = relApplicable ? absDiff / Math.abs(referenceValue) : undefined;

      // A bar passes if ANY configured numeric criterion is satisfied. For
      // most indicators only one is configured. ATR configures both
      // price-normalized and relative — either acceptance clears it.
      let passed = false;
      if (tol.maxAbsPoints !== undefined && absDiff <= tol.maxAbsPoints) passed = true;
      if (tol.maxAbsPctOfPrice !== undefined && pctOfPrice <= tol.maxAbsPctOfPrice) passed = true;
      if (tol.maxRelativePct !== undefined && relApplicable && relativePct! <= tol.maxRelativePct) passed = true;

      // Sign-mismatch note (macdHist near a zero crossing legitimately flips).
      const signMismatch = !!tol.reportSignMismatch
        && sign(localValue) !== sign(referenceValue)
        && sign(localValue) !== 0 && sign(referenceValue) !== 0;

      let severity: Severity;
      let reason: string | undefined;
      if (passed) {
        if (signMismatch) {
          severity = "soft";
          reason = "sign mismatch within magnitude tolerance (near zero crossing)";
        } else {
          severity = "pass";
        }
      } else {
        // Provisionally soft (isolated cross-venue outlier). The systematic
        // pass below escalates to hard if >10% of this indicator's bars fail.
        severity = "soft";
        reason = signMismatch
          ? "outside tolerance with sign mismatch (provisional outlier)"
          : "outside tolerance (provisional cross-venue outlier)";
      }

      const diff: IndicatorDiff = {
        ts, indicator, localValue, referenceValue, close,
        absDiff,
        passed, severity, reason,
      };
      if (tol.maxAbsPctOfPrice !== undefined) diff.pctOfPrice = pctOfPrice;
      if (tol.maxAbsPoints !== undefined)     diff.absPoints = absDiff;
      if (relativePct !== undefined)          diff.relativePct = relativePct;
      diffs.push(diff);
    }
  }

  // ── Systematic escalation: per indicator, if >10% of sampled bars failed
  //    tolerance, the indicator is a systematic (hard) failure. Escalate its
  //    out-of-tolerance soft findings to hard. Structural-missing diffs are
  //    already hard and are left as-is. Sign-mismatch-within-tolerance diffs
  //    (passed === true) do NOT count toward the failure rate.
  const indicatorSummaries: IndicatorSummary[] = [];
  for (const indicator of COMPARED_INDICATORS) {
    const tol = tolerances[indicator];
    if (!tol) continue;
    const forIndicator = diffs.filter((d) => d.indicator === indicator);
    if (forIndicator.length === 0) continue;

    const failCount = forIndicator.filter((d) => !d.passed).length;
    const systematic = failCount / forIndicator.length > SYSTEMATIC_FAILURE_FRACTION;
    if (systematic) {
      for (const d of forIndicator) {
        if (!d.passed && d.severity !== "hard") {
          d.severity = "hard";
          d.reason = `${d.reason ?? "outside tolerance"} — systematic: >${(SYSTEMATIC_FAILURE_FRACTION * 100).toFixed(0)}% of sampled bars failed`;
        }
      }
    }

    // Summary (computed after escalation so counts reflect final severities).
    let worstAbsDiff = 0;
    let worstBarTs = forIndicator[0]?.ts ?? "";
    for (const d of forIndicator) {
      const ad = d.absDiff ?? 0;
      if (ad > worstAbsDiff) { worstAbsDiff = ad; worstBarTs = d.ts; }
    }
    indicatorSummaries.push({
      indicator,
      sampledBars:  forIndicator.length,
      passed:       forIndicator.filter((d) => d.severity === "pass").length,
      softFindings: forIndicator.filter((d) => d.severity === "soft").length,
      hardFailures: forIndicator.filter((d) => d.severity === "hard").length,
      toleranceUsed: humanTolerance(tol),
      worstAbsDiff,
      worstBarTs,
    });
  }

  const hardFailures = diffs.filter((d) => d.severity === "hard");
  const softFindings = diffs.filter((d) => d.severity === "soft");

  return {
    symbol:            meta.symbol            ?? localFeatures[0]?.symbol ?? "",
    localExchange:     meta.localExchange     ?? localFeatures[0]?.exchange ?? "",
    referenceExchange: meta.referenceExchange ?? "binance",
    timeframe:         meta.timeframe         ?? localFeatures[0]?.timeframe ?? "1h",
    featureVersion:    meta.featureVersion    ?? localFeatures[0]?.featureVersion ?? "",
    sampleStartTs:     sampleTimestamps[0] ?? "",
    sampleEndTs:       sampleTimestamps[sampleTimestamps.length - 1] ?? "",
    sampledBars:       sampleTimestamps.length,
    indicatorSummaries,
    diffs,
    hardFailures,
    softFindings,
    passed: hardFailures.length === 0,
  };
}

// ─── Internal naive recomputations ──────────────────────────────────────────

/**
 * Recompute volumeSma20 and relativeVolume20 a second, dead-simple way and
 * assert the engine agrees to tight float tolerance.
 *
 * Mirrors the engine exactly: volumeSma20 is the mean of the last 20 NON-NULL
 * volumes (a null-volume bar yields null and does not advance the window),
 * and relativeVolume20 = volume / volumeSma20.
 *
 * `bars` and `features` must be the SAME contiguous series, index-aligned by
 * ts. The caller passes the full computed window (not just the sample).
 */
export function validateVolumeInternally(
  features: FeatureSnapshot[],
  bars: Bar[],
): InternalCheckResult {
  const result: InternalCheckResult = {
    name: "volume (volumeSma20, relativeVolume20)",
    checked: 0, passed: 0, failures: [], ok: true,
  };

  const barByTs = new Map<string, Bar>();
  for (const b of bars) barByTs.set(b.ts, b);

  const recentVolumes: number[] = []; // last-20 window of non-null volumes

  for (const f of features) {
    const bar = barByTs.get(f.ts);
    if (!bar) {
      result.failures.push({
        ts: f.ts, field: "volumeSma20", engine: f.volumeSma20 ?? null, naive: null,
        reason: "no matching bar for feature ts (series misalignment)",
      });
      continue;
    }

    const vol = bar.volume;
    let naiveSma: number | null;
    if (vol === null || vol === undefined) {
      naiveSma = null; // null-volume bar → null feature, window not advanced
    } else {
      recentVolumes.push(vol);
      if (recentVolumes.length > 20) recentVolumes.shift();
      naiveSma = recentVolumes.length < 20
        ? null
        : recentVolumes.reduce((a, b) => a + b, 0) / 20;
    }

    // volumeSma20
    result.checked++;
    const engSma = f.volumeSma20 ?? null;
    if (!nullableNear(engSma, naiveSma, INTERNAL_ABS_EPS)) {
      result.failures.push({
        ts: f.ts, field: "volumeSma20", engine: engSma, naive: naiveSma,
        absDiff: engSma !== null && naiveSma !== null ? Math.abs(engSma - naiveSma) : undefined,
        reason: "engine volumeSma20 != naive recompute",
      });
    } else {
      result.passed++;
    }

    // relativeVolume20
    const naiveRel = (naiveSma !== null && naiveSma !== 0 && vol !== null && vol !== undefined)
      ? vol / naiveSma
      : null;
    const engRel = f.relativeVolume20 ?? null;
    result.checked++;
    if (!nullableNear(engRel, naiveRel, INTERNAL_ABS_EPS)) {
      result.failures.push({
        ts: f.ts, field: "relativeVolume20", engine: engRel, naive: naiveRel,
        absDiff: engRel !== null && naiveRel !== null ? Math.abs(engRel - naiveRel) : undefined,
        reason: "engine relativeVolume20 != naive recompute",
      });
    } else {
      result.passed++;
    }
  }

  result.ok = result.failures.length === 0;
  return result;
}

/**
 * Recompute Bollinger Bands naively (SMA20 ± 2·population stdev over the last
 * 20 closes) and assert the engine agrees to tight float tolerance. Proves the
 * engine's BB math is self-consistent independent of the TAAPI ballpark check.
 * Population (N) stdev, not sample (N-1) — matches the engine and TradingView/TAAPI.
 */
export function validateBollingerInternally(
  features: FeatureSnapshot[],
  bars: Bar[],
  period = 20,
  stdDevs = 2,
): InternalCheckResult {
  const result: InternalCheckResult = {
    name: "bollinger (bbUpper, bbMiddle, bbLower)",
    checked: 0, passed: 0, failures: [], ok: true,
  };

  const barByTs = new Map<string, Bar>();
  for (const b of bars) barByTs.set(b.ts, b);

  const window: number[] = [];

  for (const f of features) {
    const bar = barByTs.get(f.ts);
    if (!bar) {
      result.failures.push({
        ts: f.ts, field: "bbMiddle", engine: f.bbMiddle ?? null, naive: null,
        reason: "no matching bar for feature ts (series misalignment)",
      });
      continue;
    }

    window.push(bar.close);
    if (window.length > period) window.shift();

    let naiveMiddle: number | null = null;
    let naiveUpper:  number | null = null;
    let naiveLower:  number | null = null;
    if (window.length >= period) {
      const mean = window.reduce((a, b) => a + b, 0) / period;
      let varSum = 0;
      for (const x of window) { const d = x - mean; varSum += d * d; }
      const sigma = Math.sqrt(varSum / period); // population
      naiveMiddle = mean;
      naiveUpper  = mean + stdDevs * sigma;
      naiveLower  = mean - stdDevs * sigma;
    }

    const checks: [string, number | null, number | null][] = [
      ["bbMiddle", f.bbMiddle ?? null, naiveMiddle],
      ["bbUpper",  f.bbUpper  ?? null, naiveUpper],
      ["bbLower",  f.bbLower  ?? null, naiveLower],
    ];
    for (const [field, eng, naive] of checks) {
      result.checked++;
      if (!nullableNear(eng, naive, INTERNAL_ABS_EPS)) {
        result.failures.push({
          ts: f.ts, field, engine: eng, naive,
          absDiff: eng !== null && naive !== null ? Math.abs(eng - naive) : undefined,
          reason: `engine ${field} != naive recompute`,
        });
      } else {
        result.passed++;
      }
    }
  }

  result.ok = result.failures.length === 0;
  return result;
}

/** True if both null, or both non-null and within eps. */
function nullableNear(a: number | null, b: number | null, eps: number): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= eps;
}
