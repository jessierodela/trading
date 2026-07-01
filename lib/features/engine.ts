/**
 * lib/features/engine.ts
 *
 * The feature engine.
 *
 * Two public entry points, two names, no flags:
 *
 *   computeFeaturesLatest(bars):
 *     - For live use. Computes features over the longest contiguous suffix
 *       ending at the most recent bar.
 *     - Throws NoUsableSuffixError if the input is empty.
 *     - Result includes seriesStartTs so the operator can see where the
 *       computation actually began.
 *
 *   computeFeaturesSegmented(bars):
 *     - For historical / backtest seeding.
 *     - Splits input into contiguous segments at every gap. Computes each
 *       segment independently — indicator state is NEVER carried across
 *       a gap, so warmup restarts at every segment boundary.
 *     - Returns flat rows[] + segments[] sidecar (per auditor decision).
 *     - Empty input → returns an empty result (rows=[], segments=[]).
 *
 * Both functions internally delegate to a private _computeContiguous
 * helper that trusts its input is gap-free. The helper is NOT exported.
 * Internal callers physically cannot reach it without first crossing a
 * public function that validated the input.
 *
 * The math:
 *   - rsi14            Wilder's smoothing, period 14
 *   - macd/signal/hist 12/26/9, standard EMA
 *   - ema20/50/200     standard alpha = 2/(n+1)
 *   - atr14            Wilder's, period 14, on TR = max of three ranges
 *   - bbUpper/M/Lower  20-period SMA ± 2 * population stdev
 *   - volumeSma20      simple 20-period SMA
 *   - relativeVolume20 current volume / volumeSma20
 *   - distanceFromEma20Atr  (close - ema20) / atr14
 *   - candleRangeAtr        (high - low) / atr14
 *
 *   ema*Slope is current ema - previous ema. Becomes non-null one bar
 *   after the underlying EMA becomes non-null.
 *
 * Determinism:
 *   - All indicator state is local to the contiguous helper invocation.
 *   - No Date.now in math. No Math.random. No Map iteration order
 *     dependence on insertion timing.
 *   - Same Bar[] in → bit-identical FeatureSnapshot[] out, on any run.
 */
import type {
  Bar,
  FeatureSnapshot,
  Timeframe,
  Exchange,
} from "@/lib/quant/types";
import { FEATURE_VERSION } from "@/lib/versions";
import { normalizeMarketIdentity } from "@/lib/dataQuality/marketIdentity";
import { buildDerivedSourceLineage, sourceLineageFromBar } from "@/lib/market/sourceLineage";
import {
  validateBarSeries,
  findGaps,
  longestContiguousSuffix,
  splitIntoSegments,
  type Gap,
  type BarSegment,
} from "./gaps";
import {
  createEma,
  createSma,
  createRsi,
  createAtr,
  createMacd,
  createBb,
} from "./indicators";

// ─── Public result types ──────────────────────────────────────────────────

export interface LatestFeatureResult {
  symbol:         string;
  exchange:       Exchange;
  timeframe:      Timeframe;
  featureVersion: string;
  rows:           FeatureSnapshot[];

  /**
   * The ts of the first bar in the contiguous suffix that was actually
   * computed. May be later than the original input start if there were
   * gaps further back.
   */
  seriesStartTs:  string;

  /**
   * The ts of the last bar (= last row's ts).
   */
  seriesEndTs:    string;

  /**
   * Bars in input that were dropped because they preceded the last gap.
   * Diagnostic only — never affects rows.
   */
  droppedPreGapCount: number;
}

export interface FeatureSegmentMeta {
  startTs:    string;
  endTs:      string;
  /** Total rows in this segment (length of contiguous bars input). */
  count:      number;
  /**
   * Number of rows at the start of this segment where ema200 (the slowest
   * standard indicator) is still null due to warmup. Diagnostic.
   * Exact value = min(count, 199).
   */
  warmupRows: number;
}

export interface SegmentedFeatureResult {
  symbol:         string;
  exchange:       Exchange;
  timeframe:      Timeframe;
  featureVersion: string;
  rows:           FeatureSnapshot[];
  segments:       FeatureSegmentMeta[];
  gaps:           Gap[];
  rowCount:       number;
  gapCount:       number;
}

// ─── Public entry: latest ────────────────────────────────────────────────

/**
 * Compute features over the longest contiguous suffix of `bars` ending at
 * the last bar. For live / dashboard / on-demand recompute use.
 *
 * Will throw:
 *   - BarIntegrityError if input is corrupt (mixed symbols, duplicates,
 *     non-ascending, misaligned).
 *   - NoUsableSuffixError if input is empty.
 *
 * Will NOT silently emit features across a gap. The suffix is the longest
 * contiguous run ending at the last bar — anything before the last gap is
 * not in the output.
 */
export function computeFeaturesLatest(bars: Bar[]): LatestFeatureResult {
  validateBarSeries(bars);
  const suffix = longestContiguousSuffix(bars);
  const rows = _computeContiguous(suffix);

  return {
    symbol:             suffix[0].symbol,
    exchange:           suffix[0].exchange,
    timeframe:          suffix[0].timeframe,
    featureVersion:     FEATURE_VERSION,
    rows,
    seriesStartTs:      suffix[0].ts,
    seriesEndTs:        suffix[suffix.length - 1].ts,
    droppedPreGapCount: bars.length - suffix.length,
  };
}

// ─── Public entry: segmented ─────────────────────────────────────────────

/**
 * Compute features over each contiguous segment of `bars` independently.
 * For historical persistence and backtest seeding.
 *
 * Indicator state never crosses a gap. Each segment takes its own warmup
 * period (RSI14 needs 14 bars, EMA200 needs 200, etc.) regardless of what
 * preceded the gap.
 *
 * Returns flat rows[] (concatenated across segments, ascending) plus a
 * segments[] sidecar describing where the boundaries are. Caller persists
 * via `featureStore.insertMany(result.rows, FEATURE_VERSION)` — the
 * sidecar is diagnostic, not control flow.
 *
 * Will throw:
 *   - BarIntegrityError if input is corrupt.
 *
 * Empty input → empty result (rows=[], segments=[]), no throw.
 */
export function computeFeaturesSegmented(bars: Bar[]): SegmentedFeatureResult {
  validateBarSeries(bars);

  if (bars.length === 0) {
    // Cannot infer symbol/exchange/timeframe; return placeholders.
    return {
      symbol:         "",
      exchange:       "COINBASE",
      timeframe:      "1h",
      featureVersion: FEATURE_VERSION,
      rows:           [],
      segments:       [],
      gaps:           [],
      rowCount:       0,
      gapCount:       0,
    };
  }

  const gaps = findGaps(bars);
  const segments = splitIntoSegments(bars);

  const allRows: FeatureSnapshot[] = [];
  const segmentMetas: FeatureSegmentMeta[] = [];

  for (const seg of segments) {
    // Fresh indicator state per segment — by construction of
    // _computeContiguous (it builds its own closures internally).
    const segRows = _computeContiguous(seg.bars);
    allRows.push(...segRows);
    segmentMetas.push({
      startTs:    seg.startTs,
      endTs:      seg.endTs,
      count:      segRows.length,
      // ema200 needs 200 bars to be non-null. Diagnostic only.
      warmupRows: Math.min(segRows.length, 199),
    });
  }

  return {
    symbol:         bars[0].symbol,
    exchange:       bars[0].exchange,
    timeframe:      bars[0].timeframe,
    featureVersion: FEATURE_VERSION,
    rows:           allRows,
    segments:       segmentMetas,
    gaps,
    rowCount:       allRows.length,
    gapCount:       gaps.length,
  };
}

// ─── Private contiguous computer ─────────────────────────────────────────

/**
 * Compute features for a contiguous segment of bars. Trusts its input.
 *
 * NOT exported. The only ways to reach this code are computeFeaturesLatest
 * (which has run longestContiguousSuffix) and computeFeaturesSegmented
 * (which has run splitIntoSegments). Either way, the input is guaranteed
 * gap-free before this function sees it.
 *
 * Returns one FeatureSnapshot per input bar. Indicator columns are null
 * during their respective warmups.
 */
function _computeContiguous(bars: Bar[]): FeatureSnapshot[] {
  if (bars.length === 0) return [];

  // One fresh instance per indicator per segment. State cannot leak.
  const rsi14    = createRsi(14);
  const ema20    = createEma(20);
  const ema50    = createEma(50);
  const ema200   = createEma(200);
  const atr14    = createAtr(14);
  const macd     = createMacd(12, 26, 9);
  const bb20     = createBb(20, 2);
  const volSma20 = createSma(20);

  let prevEma20:  number | null = null;
  let prevEma50:  number | null = null;
  let prevEma200: number | null = null;
  let prevBbWidth: number | null = null;

  const out: FeatureSnapshot[] = new Array(bars.length);

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const barLineage = sourceLineageFromBar(b);
    const identity = normalizeMarketIdentity({
      symbol: b.symbol,
      exchange: b.exchange,
      source: b.source ?? barLineage.provider,
      vendorSymbol: b.vendorSymbol ?? barLineage.vendorSymbol ?? b.symbol,
      quoteAsset: b.quoteAsset ?? barLineage.quoteAsset,
    });

    const rsiVal    = rsi14(b.close);
    const ema20Val  = ema20(b.close);
    const ema50Val  = ema50(b.close);
    const ema200Val = ema200(b.close);
    const atrVal    = atr14(b.high, b.low, b.close);
    const macdVal   = macd(b.close);
    const bbVal     = bb20(b.close);
    const volSmaVal = b.volume !== null && b.volume !== undefined
      ? volSma20(b.volume)
      : null;

    const ema20Slope  = ema20Val  !== null && prevEma20  !== null ? ema20Val  - prevEma20  : null;
    const ema50Slope  = ema50Val  !== null && prevEma50  !== null ? ema50Val  - prevEma50  : null;
    const ema200Slope = ema200Val !== null && prevEma200 !== null ? ema200Val - prevEma200 : null;

    const bbWidth = bbVal !== null && bbVal.bbMiddle !== 0
      ? (bbVal.bbUpper - bbVal.bbLower) / bbVal.bbMiddle
      : null;

    const atrPct = atrVal !== null && b.close !== 0
      ? (atrVal / b.close) * 100
      : null;

    const relVol = volSmaVal !== null && volSmaVal !== 0 && b.volume !== null && b.volume !== undefined
      ? b.volume / volSmaVal
      : null;

    const distFromEma20Atr = ema20Val !== null && atrVal !== null && atrVal !== 0
      ? (b.close - ema20Val) / atrVal
      : null;

    const candleRangeAtr = atrVal !== null && atrVal !== 0
      ? (b.high - b.low) / atrVal
      : null;

    out[i] = {
      symbol:    b.symbol,
      exchange:  b.exchange,
      timeframe: b.timeframe,
      ts:        b.ts,
      close:     b.close,
      source:    b.source ?? barLineage.source,
      vendorSymbol: b.vendorSymbol ?? barLineage.vendorSymbol ?? b.symbol,
      quoteAsset: b.quoteAsset ?? barLineage.quoteAsset,

      rsi14:        rsiVal,
      macd:         macdVal?.macd       ?? null,
      macdSignal:   macdVal?.macdSignal ?? null,
      macdHist:     macdVal?.macdHist   ?? null,

      ema20:        ema20Val,
      ema50:        ema50Val,
      ema200:       ema200Val,
      ema20Slope,
      ema50Slope,
      ema200Slope,

      atr14:        atrVal,
      atrPct,
      bbUpper:      bbVal?.bbUpper  ?? null,
      bbMiddle:     bbVal?.bbMiddle ?? null,
      bbLower:      bbVal?.bbLower  ?? null,
      bbWidth,
      bbWidthPrev:  prevBbWidth,

      volumeSma20:      volSmaVal,
      relativeVolume20: relVol,

      distanceFromEma20Atr: distFromEma20Atr,
      candleRangeAtr,

      // Cross-timeframe context set elsewhere (1d feature snapshot joined
      // onto 1h rows). Not the engine's job — left null here.
      daily_ema50AboveEma200: null,
      daily_priceAboveEma200: null,

      featureVersion: FEATURE_VERSION,
      sourceLineage: buildDerivedSourceLineage({
        kind: "feature_snapshot",
        source: "features.compute",
        transform: FEATURE_VERSION,
        transformedAt: b.ts,
        identity,
        inputSources: [barLineage],
        featureVersion: FEATURE_VERSION,
      }),
    };

    prevEma20  = ema20Val;
    prevEma50  = ema50Val;
    prevEma200 = ema200Val;
    prevBbWidth = bbWidth;
  }

  return out;
}
