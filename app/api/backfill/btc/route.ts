/**
 * app/api/backfill/btc/route.ts
 *
 * POST /api/backfill/btc
 *
 * Backfills BTC-USD 1h OHLCV bars from Coinbase Exchange REST into the
 * market_bars table, then rolls up into 1d bars locally and inserts those
 * too. Idempotent — `onConflict: 'ignore'` on insert.
 *
 * ─── First milestone where the desk has its own data ─────────────────────
 * Until this route runs, market_bars is empty and the feature engine (P2C)
 * has nothing to compute on. After it runs, the desk has a self-contained
 * source of truth for BTC bars and TAAPI is no longer the only path to
 * indicator data.
 *
 * ─── Vercel time budget ───────────────────────────────────────────────────
 * Vercel serverless function caps:
 *   Hobby: 10s
 *   Pro:   60s (default)
 *   Fluid: 800s (opt-in)
 *
 * 1 year of 1h bars = 8760 bars / 300 per request = ~30 requests at 200ms
 * gap + ~300ms per fetch ≈ ~15s. Comfortably inside Pro's 60s.
 *
 * BUT: cold start + Coinbase variance + DB insert latency can push that
 * higher. So we implement a soft time budget. If the elapsed wall time
 * crosses `timeBudgetMs` (default 45s for Pro), we stop fetching, persist
 * what we have, and return a `resumeCursor`. The caller re-POSTs with
 * `{ startTs: resumeCursor }` to continue.
 *
 * For 1 year @ 1h this will almost always be one call. The chunking is
 * insurance, not the common path.
 *
 * ─── Connection strategy ──────────────────────────────────────────────────
 * Architecture (ARCHITECTURE.md §4) prefers supabase-js for Vercel reads
 * and pg for the Railway worker. This route is a WRITE-heavy bulk
 * operation on Vercel — neither preferred path quite fits.
 *
 * Decision: use pg via getPgPool(). The cold-start reconnect cost is
 * acceptable because (a) backfill is rare, not per-request, and (b)
 * insertMany() pushes ~3000 rows in one query, which is exactly the
 * pattern pg handles best. supabase-js would require ~30 REST round-trips.
 *
 * ─── Auth ────────────────────────────────────────────────────────────────
 * Interim secret-header guard via X-Backfill-Secret + BACKFILL_SECRET env.
 * Not real auth — replaced by uniform P6 auth alongside the risk engine.
 * Refuses to run if BACKFILL_SECRET is unset (loud misconfig vs silent fail-open).
 *
 * ─── Request body ─────────────────────────────────────────────────────────
 * All fields optional. Defaults: last 365 days, BTC-USD, 1h source.
 *
 *   {
 *     "startTs":      "2025-05-15T00:00:00Z",   // ISO-8601, default 365d ago
 *     "endTs":        "2026-05-15T00:00:00Z",   // ISO-8601, default now (truncated to hour)
 *     "timeBudgetMs": 45000,                     // soft cap, clamped to [1000, 55000]
 *     "rollupDaily":  true,                      // emit 1d bars from 1h, default true
 *     "requireFullDay": true                     // DEFAULT TRUE — see below
 *   }
 *
 * ─── Partial-day protection ──────────────────────────────────────────────
 * requireFullDay defaults to TRUE. The 1h bars stored cover everything up
 * to the last fully-closed hour, but the 1d rollup explicitly excludes the
 * in-progress UTC day. Without this, the rollup would write a partial
 * daily bar, and onConflict='ignore' on a later run would lock it in
 * permanently — corrupting every daily indicator (EMA50/200, ATR, regime).
 *
 * Pass requireFullDay: false only if you have a non-backtest use case for
 * partial daily bars (live UI preview) and you understand the trap.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getPgPool,
  PgBarStore,
  ValidationError,
} from "@/lib/storage";
import {
  fetchCandleWindow,
  MAX_CANDLES_PER_REQUEST,
  CoinbaseRestError,
} from "@/lib/data/coinbaseRest";
import { rollupBars } from "@/lib/data/rollup";
import { DATA_SOURCE_COINBASE_REST } from "@/lib/versions";

// Mutation route — never cached, always re-evaluated.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const SYMBOL    = "BTC-USD";
const TIMEFRAME = "1h" as const;
const GRANULARITY_SEC = 3_600;

// ─── Body parsing ─────────────────────────────────────────────────────────

interface BackfillBody {
  startTs?:        string;
  endTs?:          string;
  timeBudgetMs?:   number;
  rollupDaily?:    boolean;
  requireFullDay?: boolean;
}

interface ResolvedParams {
  startTs:        string;
  endTs:          string;
  timeBudgetMs:   number;
  rollupDaily:    boolean;
  requireFullDay: boolean;
}

/**
 * Truncate ms to the start of its UTC hour. We never want a partial bar
 * at the end of the range — Coinbase would return the in-progress bar
 * with current values and we'd cache that as if it were closed.
 */
function truncateToHourMs(ms: number): number {
  return Math.floor(ms / 1000 / GRANULARITY_SEC) * GRANULARITY_SEC * 1000;
}

/**
 * Truncate ms to the start of its UTC day. Used to refuse the
 * currently-in-progress UTC day from the 1d rollup, which would otherwise
 * insert a malformed partial daily and have it locked in by
 * onConflict='ignore' on the next pass.
 */
function truncateToUtcDayMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

// Vercel function caps — clamp upper bound to leave headroom below the
// 60s Pro limit. Floor avoids degenerate near-zero budgets.
const MIN_TIME_BUDGET_MS = 1_000;
const MAX_TIME_BUDGET_MS = 55_000;

function resolveParams(body: BackfillBody): ResolvedParams {
  const nowMs = Date.now();
  // End defaults to the start of the current hour — last fully-closed bar
  // is the one immediately preceding.
  const defaultEndMs   = truncateToHourMs(nowMs);
  const defaultStartMs = defaultEndMs - 365 * 24 * 60 * 60 * 1000;   // 365 days back

  const startTs = body.startTs ?? new Date(defaultStartMs).toISOString();
  const endTs   = body.endTs   ?? new Date(defaultEndMs).toISOString();

  // Clamp time budget. Caller can't ask for 0 (immediate no-op) or 999s
  // (will be killed by Vercel mid-response). 45s default leaves 15s headroom
  // on Pro's 60s cap.
  const rawBudget = body.timeBudgetMs ?? 45_000;
  const timeBudgetMs = Math.max(MIN_TIME_BUDGET_MS, Math.min(rawBudget, MAX_TIME_BUDGET_MS));

  return {
    startTs,
    endTs,
    timeBudgetMs,
    rollupDaily:    body.rollupDaily    ?? true,
    // Default TRUE: never store a partial UTC day. A partial daily bar
    // would be permanently locked in by onConflict='ignore' on later runs
    // and would corrupt every daily indicator (EMA50/200, ATR, regime
    // context). Callers who explicitly want partial daily bars (UI preview,
    // never for backtest) must opt in.
    requireFullDay: body.requireFullDay ?? true,
  };
}

// ─── Response shape ───────────────────────────────────────────────────────

interface BackfillResponse {
  ok:             true;
  symbol:         string;
  timeframe:      "1h";
  requestedRange: { startTs: string; endTs: string };
  fetchedBars:    number;
  insertedBars1h: number;
  insertedBars1d: number;
  /** Present if the time budget was hit before completing the range. */
  resumeCursor?:  string;
  durationMs:     number;
  windows:        number;
  dataSourceVersion: string;
}

interface BackfillErrorResponse {
  ok:    false;
  error: string;
  partial?: {
    insertedBars1h: number;
    insertedBars1d: number;
    completedThroughTs: string;
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startedAtMs = Date.now();

  // ── Auth guard (interim — replaced by uniform P6 auth)
  //
  // Not real auth. A single shared secret in BACKFILL_SECRET env var, checked
  // against the X-Backfill-Secret header. The goal is to keep a stranger
  // who finds a Vercel preview URL from triggering DB writes / Coinbase
  // burst traffic — not to defend against a determined attacker.
  //
  // If BACKFILL_SECRET is unset, the route refuses to run rather than
  // fail-open. That makes the misconfiguration loud instead of silent.
  // For local dev: set BACKFILL_SECRET=dev in .env.local.
  const configured = process.env.BACKFILL_SECRET;
  if (!configured) {
    return NextResponse.json<BackfillErrorResponse>(
      { ok: false, error: "BACKFILL_SECRET not configured on server — route refuses to run" },
      { status: 503 },
    );
  }
  const supplied = req.headers.get("x-backfill-secret");
  if (supplied !== configured) {
    return NextResponse.json<BackfillErrorResponse>(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  // ── Parse body
  let body: BackfillBody = {};
  try {
    const text = await req.text();
    if (text.length > 0) body = JSON.parse(text) as BackfillBody;
  } catch {
    return NextResponse.json<BackfillErrorResponse>(
      { ok: false, error: "request body is not valid JSON" },
      { status: 400 },
    );
  }
  const params = resolveParams(body);
  console.log(`[backfill/btc] POST start=${params.startTs} end=${params.endTs} budget=${params.timeBudgetMs}ms`);

  // ── Validate range
  const startMs = Date.parse(params.startTs);
  const endMs   = Date.parse(params.endTs);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return NextResponse.json<BackfillErrorResponse>(
      { ok: false, error: `invalid startTs/endTs: ${params.startTs} / ${params.endTs}` },
      { status: 400 },
    );
  }
  if (startMs >= endMs) {
    return NextResponse.json<BackfillErrorResponse>(
      { ok: false, error: `startTs (${params.startTs}) must be < endTs (${params.endTs})` },
      { status: 400 },
    );
  }

  // ── Set up storage
  let pool;
  try {
    pool = getPgPool();
  } catch (err) {
    return NextResponse.json<BackfillErrorResponse>(
      { ok: false, error: `pg pool init failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
  const bars = new PgBarStore(pool);

  // ── Walk forward in 300-candle windows
  const windowMs       = MAX_CANDLES_PER_REQUEST * GRANULARITY_SEC * 1_000;
  const requestGapMs   = 200;

  const collected1h: import("@/lib/quant/types").Bar[] = [];
  let cursor = startMs;
  let windowCount = 0;
  let timeBudgetHit = false;
  let isFirst = true;

  try {
    while (cursor < endMs) {
      // Check time budget BEFORE the next network call so we don't exceed it
      // while waiting on Coinbase.
      const elapsed = Date.now() - startedAtMs;
      if (elapsed > params.timeBudgetMs) {
        console.log(`[backfill/btc] time budget hit at ${elapsed}ms, cursor=${new Date(cursor).toISOString()}`);
        timeBudgetHit = true;
        break;
      }

      if (!isFirst) {
        await new Promise((r) => setTimeout(r, requestGapMs));
      }
      isFirst = false;

      const windowEnd = Math.min(cursor + windowMs, endMs);
      const windowEndIso = new Date(windowEnd).toISOString();
      const windowStartIso = new Date(cursor).toISOString();

      console.log(`[backfill/btc] window ${windowCount + 1}: ${windowStartIso} → ${windowEndIso}`);
      const batch = await fetchCandleWindow(SYMBOL, TIMEFRAME, windowStartIso, windowEndIso);
      collected1h.push(...batch);
      windowCount++;
      cursor = windowEnd;
    }
  } catch (err) {
    // Network or parse error mid-fetch. Try to persist what we have, then
    // surface the failure.
    console.error(`[backfill/btc] fetch error after ${windowCount} window(s):`, err);

    const partialResult = await tryInsertCollected(bars, collected1h, params);
    return NextResponse.json<BackfillErrorResponse>(
      {
        ok: false,
        error: err instanceof CoinbaseRestError
          ? `coinbase fetch failed: ${err.message}${err.status ? ` (status ${err.status})` : ""}`
          : `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        partial: partialResult,
      },
      { status: 502 },
    );
  }

  // ── Dedup across windows (boundary bars can appear in adjacent ranges)
  const seen = new Set<string>();
  const deduped: typeof collected1h = [];
  for (const b of collected1h) {
    if (seen.has(b.ts)) continue;
    seen.add(b.ts);
    deduped.push(b);
  }

  // ── Insert 1h bars
  let insertedBars1h = 0;
  if (deduped.length > 0) {
    try {
      insertedBars1h = await bars.insertMany(
        deduped,
        DATA_SOURCE_COINBASE_REST,
        { onConflict: "ignore" },
      );
    } catch (err) {
      if (err instanceof ValidationError) {
        return NextResponse.json<BackfillErrorResponse>(
          { ok: false, error: `bar validation failed: ${err.message}` },
          { status: 422 },
        );
      }
      throw err;
    }
  }

  // ── Roll up to 1d and insert
  let insertedBars1d = 0;
  if (params.rollupDaily && deduped.length > 0) {
    // Two-layer defense against the partial-day trap.
    //
    // The original bug: route truncates endTs to the current UTC HOUR, not
    // the current UTC DAY. If the caller runs at 14:00 UTC, the deduped
    // array contains 14 hourly bars for today. Rolling those up produces
    // a partial daily bar that gets locked into market_bars by
    // onConflict='ignore', corrupting every daily indicator forever.
    //
    // Layer 1 (here): when requireFullDay=true, refuse to even consider
    //   bars from the current in-progress UTC day. Cheap, explicit, easy to
    //   read in route flow.
    // Layer 2 (rollupBars): requireFullPeriod=true drops any day with
    //   fewer than 24 hourly bars. Catches the edge case where the start of
    //   a backfill range is mid-day.
    //
    // Either layer alone would catch the original bug, but the cost of
    // both is negligible and the defense-in-depth is worth it for
    // backtest-grade data quality.
    let rollupInput = deduped;
    if (params.requireFullDay) {
      const inProgressDayStartIso = new Date(truncateToUtcDayMs(Date.now())).toISOString();
      const before = rollupInput.length;
      rollupInput = rollupInput.filter((b) => b.ts < inProgressDayStartIso);
      const dropped = before - rollupInput.length;
      if (dropped > 0) {
        console.log(
          `[backfill/btc] dropped ${dropped} bars from in-progress UTC day ` +
          `(>= ${inProgressDayStartIso}) before 1d rollup`
        );
      }
    }

    const daily = rollupBars(rollupInput, "1d", { requireFullPeriod: params.requireFullDay });
    if (daily.length > 0) {
      try {
        insertedBars1d = await bars.insertMany(
          daily,
          DATA_SOURCE_COINBASE_REST,
          { onConflict: "ignore" },
        );
      } catch (err) {
        if (err instanceof ValidationError) {
          // Don't fail the whole request — 1h already persisted. Log and
          // return the partial success.
          console.error(`[backfill/btc] 1d rollup validation failed: ${err.message}`);
        } else {
          throw err;
        }
      }
    }
  }

  const response: BackfillResponse = {
    ok:                true,
    symbol:            SYMBOL,
    timeframe:         TIMEFRAME,
    requestedRange:    { startTs: params.startTs, endTs: params.endTs },
    fetchedBars:       deduped.length,
    insertedBars1h,
    insertedBars1d,
    durationMs:        Date.now() - startedAtMs,
    windows:           windowCount,
    dataSourceVersion: DATA_SOURCE_COINBASE_REST,
  };
  if (timeBudgetHit) {
    response.resumeCursor = new Date(cursor).toISOString();
  }

  console.log(
    `[backfill/btc] ok windows=${windowCount} fetched=${deduped.length} ` +
    `inserted1h=${insertedBars1h} inserted1d=${insertedBars1d} duration=${response.durationMs}ms` +
    (timeBudgetHit ? ` resume=${response.resumeCursor}` : "")
  );
  return NextResponse.json(response);
}

// ─── Helper: best-effort partial insert on mid-fetch failure ─────────────

async function tryInsertCollected(
  bars: PgBarStore,
  collected: import("@/lib/quant/types").Bar[],
  params: ResolvedParams,
): Promise<{ insertedBars1h: number; insertedBars1d: number; completedThroughTs: string }> {
  if (collected.length === 0) {
    return { insertedBars1h: 0, insertedBars1d: 0, completedThroughTs: params.startTs };
  }

  // Dedup
  const seen = new Set<string>();
  const deduped: typeof collected = [];
  for (const b of collected) {
    if (seen.has(b.ts)) continue;
    seen.add(b.ts);
    deduped.push(b);
  }

  let inserted1h = 0;
  let inserted1d = 0;
  try {
    inserted1h = await bars.insertMany(
      deduped,
      DATA_SOURCE_COINBASE_REST,
      { onConflict: "ignore" },
    );
    if (params.rollupDaily) {
      // Same two-layer defense as the success path. See main handler.
      let rollupInput = deduped;
      if (params.requireFullDay) {
        const inProgressDayStartIso = new Date(truncateToUtcDayMs(Date.now())).toISOString();
        rollupInput = rollupInput.filter((b) => b.ts < inProgressDayStartIso);
      }
      const daily = rollupBars(rollupInput, "1d", { requireFullPeriod: params.requireFullDay });
      if (daily.length > 0) {
        inserted1d = await bars.insertMany(
          daily,
          DATA_SOURCE_COINBASE_REST,
          { onConflict: "ignore" },
        );
      }
    }
  } catch (err) {
    console.error("[backfill/btc] partial insert also failed:", err);
  }

  const lastTs = deduped[deduped.length - 1]?.ts ?? params.startTs;
  return {
    insertedBars1h: inserted1h,
    insertedBars1d: inserted1d,
    completedThroughTs: lastTs,
  };
}