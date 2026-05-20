/**
 * app/api/features/compute/route.ts
 *
 * POST /api/features/compute
 *
 * Compute and persist features from market_bars into feature_snapshots.
 *
 * ─── Mode is required ────────────────────────────────────────────────────
 * Body must include `mode: "latest" | "segmented"`. No default. Per the
 * auditor's locked-in contract: callers cannot accidentally pick the
 * wrong behavior — they must explicitly state which gap-handling strategy
 * they want.
 *
 *   "latest"     — for live / on-demand recompute. Computes features over
 *                  the longest contiguous suffix ending at the most recent
 *                  bar. Anything before the last gap is silently dropped
 *                  from output but reported as droppedPreGapCount.
 *
 *   "segmented"  — for historical persistence / backtest seeding. Splits
 *                  input into contiguous segments at every gap. Warmup
 *                  restarts at every segment boundary — indicator state
 *                  never crosses a gap.
 *
 * ─── Engine never crosses gaps ──────────────────────────────────────────
 * Both modes refuse to compute strategy-grade features across missing
 * candles. This is the P2C invariant — the entire reason the engine
 * exists in two pieces.
 *
 * ─── Auth ────────────────────────────────────────────────────────────────
 * Same shared-secret pattern as /api/backfill/btc. Reuses BACKFILL_SECRET
 * per the auditor's call (avoid secret sprawl; P6 wires uniform auth).
 * FEATURES_SECRET is checked first if set, for the transitional case
 * where someone wants split secrets before P6 lands.
 *
 * ─── Body ────────────────────────────────────────────────────────────────
 *   {
 *     "mode":      "latest" | "segmented",  // required
 *     "symbol":    "BTC-USD",                // required
 *     "exchange":  "COINBASE",               // required
 *     "timeframe": "1h",                     // required
 *     "startTs":   "...",                    // required
 *     "endTs":     "...",                    // required
 *     "persist":   true                       // optional, default true
 *   }
 *
 * `persist: false` runs the engine and returns the rows without writing.
 * Useful for inspection / debugging without polluting feature_snapshots.
 *
 * ─── Response (success) ──────────────────────────────────────────────────
 *   {
 *     "ok":              true,
 *     "mode":            "latest" | "segmented",
 *     "symbol":          "BTC-USD",
 *     "exchange":        "COINBASE",
 *     "timeframe":       "1h",
 *     "featureVersion":  "features.2026-05-16.v2",
 *     "barsRead":        8760,
 *     "rowsComputed":    8760,                  // = result.rows.length
 *     "rowsPersisted":   8760,                  // 0 if persist=false
 *     "seriesStartTs":   "...",                 // latest mode only
 *     "seriesEndTs":     "...",                 // latest mode only
 *     "droppedPreGap":   0,                     // latest mode only
 *     "segments":        [...],                 // segmented mode only
 *     "gaps":            [...],                 // segmented mode only
 *     "durationMs":      842
 *   }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getPgPool,
  PgBarStore,
  PgFeatureStore,
  ValidationError,
} from "@/lib/storage";
import {
  computeFeaturesLatest,
  computeFeaturesSegmented,
  type LatestFeatureResult,
  type SegmentedFeatureResult,
} from "@/lib/features/engine";
import {
  BarIntegrityError,
  NoUsableSuffixError,
} from "@/lib/features/gaps";
import type { Timeframe, Exchange } from "@/lib/quant/types";

export const dynamic   = "force-dynamic";
export const revalidate = 0;

const ALLOWED_MODES = ["latest", "segmented"] as const;
type Mode = (typeof ALLOWED_MODES)[number];

const ALLOWED_TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "1d"];
const ALLOWED_EXCHANGES: Exchange[]   = ["COINBASE", "BINANCE", "POLYGON"];

// ─── Body ─────────────────────────────────────────────────────────────────

interface ComputeBody {
  mode?:      string;
  symbol?:    string;
  exchange?:  string;
  timeframe?: string;
  startTs?:   string;
  endTs?:     string;
  persist?:   boolean;
}

interface ResolvedParams {
  mode:      Mode;
  symbol:    string;
  exchange:  Exchange;
  timeframe: Timeframe;
  startTs:   string;
  endTs:     string;
  persist:   boolean;
}

interface ErrorResponse {
  ok:    false;
  error: string;
}

function parseAndValidate(body: ComputeBody): ResolvedParams | { error: string } {
  if (!body.mode || !ALLOWED_MODES.includes(body.mode as Mode)) {
    return { error: `mode is required and must be one of ${ALLOWED_MODES.join(", ")}` };
  }
  if (!body.symbol || typeof body.symbol !== "string") {
    return { error: "symbol is required" };
  }
  if (!body.exchange || !ALLOWED_EXCHANGES.includes(body.exchange as Exchange)) {
    return { error: `exchange is required and must be one of ${ALLOWED_EXCHANGES.join(", ")}` };
  }
  if (!body.timeframe || !ALLOWED_TIMEFRAMES.includes(body.timeframe as Timeframe)) {
    return { error: `timeframe is required and must be one of ${ALLOWED_TIMEFRAMES.join(", ")}` };
  }
  if (!body.startTs || !body.endTs) {
    return { error: "startTs and endTs are required" };
  }
  const sMs = Date.parse(body.startTs);
  const eMs = Date.parse(body.endTs);
  if (Number.isNaN(sMs) || Number.isNaN(eMs)) {
    return { error: `invalid startTs/endTs: ${body.startTs} / ${body.endTs}` };
  }
  if (sMs >= eMs) {
    return { error: `startTs must be < endTs (got ${body.startTs} / ${body.endTs})` };
  }

  return {
    mode:      body.mode as Mode,
    symbol:    body.symbol,
    exchange:  body.exchange as Exchange,
    timeframe: body.timeframe as Timeframe,
    startTs:   body.startTs,
    endTs:     body.endTs,
    persist:   body.persist ?? true,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startedAtMs = Date.now();

  // ── Auth (same pattern as /api/backfill/btc).
  // FEATURES_SECRET takes precedence if set (transitional split-secret
  // path); otherwise BACKFILL_SECRET. Refusal if neither is set, to make
  // misconfig loud.
  const configured = process.env.FEATURES_SECRET ?? process.env.BACKFILL_SECRET;
  if (!configured) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "FEATURES_SECRET or BACKFILL_SECRET not configured on server — route refuses to run" },
      { status: 503 },
    );
  }
  const supplied = req.headers.get("x-backfill-secret");
  if (supplied !== configured) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  // ── Body parse + validate
  let body: ComputeBody;
  try {
    const text = await req.text();
    body = text.length > 0 ? JSON.parse(text) as ComputeBody : {};
  } catch {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "request body is not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = parseAndValidate(body);
  if ("error" in parsed) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: parsed.error },
      { status: 400 },
    );
  }
  const params = parsed;

  console.log(
    `[features/compute] mode=${params.mode} ${params.symbol}@${params.exchange} ${params.timeframe} ` +
    `${params.startTs} → ${params.endTs} persist=${params.persist}`
  );

  // ── DB setup
  let pool;
  try {
    pool = getPgPool();
  } catch (err) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: `pg pool init failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
  const barStore     = new PgBarStore(pool);
  const featureStore = new PgFeatureStore(pool);

  // ── Read bars
  let bars;
  try {
    bars = await barStore.fetchRange(
      { symbol: params.symbol, exchange: params.exchange, timeframe: params.timeframe },
      { startTs: params.startTs, endTs: params.endTs },
    );
  } catch (err) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: `bar fetch failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  if (bars.length === 0) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: `no bars found in market_bars for the requested range` },
      { status: 404 },
    );
  }

  // ── Run the engine. Explicit dispatch — never a flag.
  let latestResult:    LatestFeatureResult    | null = null;
  let segmentedResult: SegmentedFeatureResult | null = null;
  try {
    if (params.mode === "latest") {
      latestResult = computeFeaturesLatest(bars);
    } else {
      segmentedResult = computeFeaturesSegmented(bars);
    }
  } catch (err) {
    if (err instanceof BarIntegrityError) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: `bar integrity violation: ${err.message}` },
        { status: 422 },
      );
    }
    if (err instanceof NoUsableSuffixError) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: `no usable contiguous suffix in the requested range` },
        { status: 422 },
      );
    }
    throw err;
  }

  const rows = latestResult?.rows ?? segmentedResult?.rows ?? [];

  // ── Persist
  let rowsPersisted = 0;
  if (params.persist && rows.length > 0) {
    try {
      rowsPersisted = await featureStore.insertMany(rows);
    } catch (err) {
      if (err instanceof ValidationError) {
        return NextResponse.json<ErrorResponse>(
          { ok: false, error: `feature validation failed: ${err.message}` },
          { status: 422 },
        );
      }
      throw err;
    }
  }

  const durationMs = Date.now() - startedAtMs;

  if (params.mode === "latest" && latestResult) {
    console.log(
      `[features/compute] latest ok rows=${latestResult.rows.length} persisted=${rowsPersisted} ` +
      `dropped=${latestResult.droppedPreGapCount} duration=${durationMs}ms`
    );
    return NextResponse.json({
      ok:             true,
      mode:           "latest" as const,
      symbol:         latestResult.symbol,
      exchange:       latestResult.exchange,
      timeframe:      latestResult.timeframe,
      featureVersion: latestResult.featureVersion,
      barsRead:       bars.length,
      rowsComputed:   latestResult.rows.length,
      rowsPersisted,
      seriesStartTs:  latestResult.seriesStartTs,
      seriesEndTs:    latestResult.seriesEndTs,
      droppedPreGap:  latestResult.droppedPreGapCount,
      durationMs,
    });
  }

  // segmented branch
  const seg = segmentedResult!;
  console.log(
    `[features/compute] segmented ok rows=${seg.rows.length} persisted=${rowsPersisted} ` +
    `segments=${seg.segments.length} gaps=${seg.gapCount} duration=${durationMs}ms`
  );
  return NextResponse.json({
    ok:             true,
    mode:           "segmented" as const,
    symbol:         seg.symbol,
    exchange:       seg.exchange,
    timeframe:      seg.timeframe,
    featureVersion: seg.featureVersion,
    barsRead:       bars.length,
    rowsComputed:   seg.rows.length,
    rowsPersisted,
    segments:       seg.segments,
    gaps:           seg.gaps,
    gapCount:       seg.gapCount,
    durationMs,
  });
}
