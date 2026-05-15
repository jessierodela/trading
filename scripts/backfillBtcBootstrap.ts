/**
 * scripts/backfillBtcBootstrap.ts
 *
 * Drives the /api/backfill/btc route in chunks until N years of BTC-USD 1h
 * history is present. Meets the P2 plan acceptance criterion of "at least
 * 2 years of BTC historical candles" without changing the route's 1-year
 * default (which the user chose for fast smoke iteration).
 *
 * Why a script, not a route default:
 *   - Route defaults to 1 year per the user's choice during P2B scoping.
 *   - Bootstrap is a one-time-per-asset operation. Lives outside the API
 *     surface, runs locally or from CI, makes its progress visible.
 *   - Each route invocation is bounded by Vercel's serverless time cap.
 *     Walking the range from a long-running script lets us cover any N
 *     years without hitting that cap.
 *
 * Usage:
 *   BACKFILL_URL=https://your-app.vercel.app \
 *   BACKFILL_SECRET=... \
 *   YEARS=2 \
 *   npm run backfill:btc:bootstrap
 *
 * Env vars:
 *   BACKFILL_URL    — base URL of the deployed app (no trailing slash). Required.
 *   BACKFILL_SECRET — secret to send as X-Backfill-Secret. Required.
 *   YEARS           — how many years back to bootstrap. Default 2.
 *   CHUNK_DAYS      — window per route call. Default 60 (well under Vercel
 *                     time budget at 1h granularity).
 *   GAP_MS          — wait between route calls. Default 1000.
 *
 * Behavior:
 *   - Walks backward from the start of the current UTC day in CHUNK_DAYS
 *     windows.
 *   - Each call uses requireFullDay=true (route default) so no partial
 *     daily bars get written.
 *   - Idempotent: re-running is safe; already-stored bars are skipped at
 *     the DB level via onConflict='ignore'.
 *   - Fails loudly on non-2xx route responses with the route's error body.
 *   - Honors the route's resumeCursor by retrying the same window when
 *     truncated by time budget.
 */

interface RouteOk {
  ok:             true;
  symbol:         string;
  timeframe:      "1h";
  requestedRange: { startTs: string; endTs: string };
  fetchedBars:    number;
  insertedBars1h: number;
  insertedBars1d: number;
  windows:        number;
  durationMs:     number;
  dataSourceVersion: string;
  resumeCursor?:  string;
}

interface RouteErr {
  ok:    false;
  error: string;
  partial?: {
    insertedBars1h: number;
    insertedBars1d: number;
    completedThroughTs: string;
  };
}

function envRequired(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: env ${name} is required.`);
    process.exit(1);
  }
  return v;
}

function envNumber(name: string, dflt: number): number {
  const raw = process.env[name];
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`ERROR: env ${name} must be a positive number (got ${raw}).`);
    process.exit(1);
  }
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function callBackfill(
  base: string,
  secret: string,
  startTs: string,
  endTs: string,
): Promise<RouteOk> {
  const url = `${base}/api/backfill/btc`;
  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "X-Backfill-Secret": secret,
    },
    body: JSON.stringify({ startTs, endTs, requireFullDay: true }),
  });
  const bodyText = await res.text();
  let parsed: RouteOk | RouteErr;
  try {
    parsed = JSON.parse(bodyText) as RouteOk | RouteErr;
  } catch {
    throw new Error(`route returned non-JSON (${res.status}): ${bodyText.slice(0, 300)}`);
  }
  if (!res.ok || !parsed.ok) {
    const errMsg = !parsed.ok ? parsed.error : `status ${res.status}`;
    throw new Error(`route failed: ${errMsg} (window ${startTs} → ${endTs})`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const base    = envRequired("BACKFILL_URL").replace(/\/+$/, "");
  const secret  = envRequired("BACKFILL_SECRET");
  const years   = envNumber("YEARS", 2);
  const chunkDays = envNumber("CHUNK_DAYS", 60);
  const gapMs     = envNumber("GAP_MS", 1_000);

  // End at the start of the current UTC day. The route itself will further
  // exclude the in-progress day from the rollup, but anchoring to a stable
  // boundary here makes the chunking math clean.
  const now = new Date();
  const endAnchorMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
  const totalRangeMs = years * 365 * 24 * 3_600 * 1_000;
  const startAnchorMs = endAnchorMs - totalRangeMs;
  const chunkMs       = chunkDays * 24 * 3_600 * 1_000;

  const totalChunks = Math.ceil(totalRangeMs / chunkMs);
  console.log(`Bootstrap: ${years}y of BTC-USD 1h via ${base}`);
  console.log(`Range: ${new Date(startAnchorMs).toISOString()} → ${new Date(endAnchorMs).toISOString()}`);
  console.log(`${totalChunks} chunk(s) of ${chunkDays} day(s), ${gapMs}ms gap`);

  // Walk forward from start, chunk by chunk. (Forward, not backward — keeps
  // the natural ordering of inserts ascending, which is friendlier for any
  // index churn on market_bars.)
  let cursor = startAnchorMs;
  let chunkIdx = 0;
  let totalInserted1h = 0;
  let totalInserted1d = 0;
  const startedMs = Date.now();

  while (cursor < endAnchorMs) {
    const chunkEnd = Math.min(cursor + chunkMs, endAnchorMs);
    chunkIdx++;

    // Inner resume loop: keep calling with the same upstream cursor as long
    // as the route returns a resumeCursor that still falls inside this chunk.
    let innerStart = cursor;
    let attempt    = 0;
    while (innerStart < chunkEnd) {
      attempt++;
      const startIso = new Date(innerStart).toISOString();
      const endIso   = new Date(chunkEnd).toISOString();
      process.stdout.write(
        `[chunk ${chunkIdx}/${totalChunks}${attempt > 1 ? ` resume ${attempt}` : ""}] ${startIso} → ${endIso} ... `
      );

      const result = await callBackfill(base, secret, startIso, endIso);
      console.log(
        `fetched=${result.fetchedBars} ins1h=${result.insertedBars1h} ` +
        `ins1d=${result.insertedBars1d} t=${result.durationMs}ms` +
        (result.resumeCursor ? ` resume=${result.resumeCursor}` : "")
      );

      totalInserted1h += result.insertedBars1h;
      totalInserted1d += result.insertedBars1d;

      if (result.resumeCursor) {
        const resumeMs = Date.parse(result.resumeCursor);
        if (Number.isNaN(resumeMs) || resumeMs <= innerStart) {
          throw new Error(
            `route returned invalid resumeCursor ${result.resumeCursor} (not advancing from ${startIso})`
          );
        }
        innerStart = resumeMs;
        await sleep(gapMs);
      } else {
        innerStart = chunkEnd;   // done with this chunk
      }
    }

    cursor = chunkEnd;
    if (cursor < endAnchorMs) await sleep(gapMs);
  }

  const elapsedSec = ((Date.now() - startedMs) / 1000).toFixed(1);
  console.log("");
  console.log(`Done. Total inserted: 1h=${totalInserted1h} 1d=${totalInserted1d} in ${elapsedSec}s.`);
  console.log("(Already-present bars are skipped silently — re-running is safe.)");
}

main().catch((err) => {
  console.error("\nBootstrap failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});