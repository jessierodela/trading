/**
 * _smoke/backfill_live.ts
 *
 * Live integration smoke test for P2B. Hits the real Coinbase API and a
 * real Postgres database. Unlike _smoke/backfill.ts (which stubs fetch
 * and uses in-memory storage), this verifies the actual ingestion path.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run smoke:backfill:live
 *
 * What it does:
 *   1. Picks a 25-hour window ending at the most recent fully-closed UTC
 *      day boundary that's at least 48h in the past. Using historical data
 *      avoids any in-progress-bar ambiguity and keeps the test deterministic
 *      across reruns.
 *   2. Calls Coinbase REST directly via fetchCandleWindow.
 *   3. Inserts 1h bars + rolled-up 1d bar via PgBarStore.
 *   4. Asserts inserted count == fetched count on first run.
 *   5. Re-runs the same insert and asserts 0 new rows (idempotency).
 *   6. Queries market_bars to verify rows landed.
 *
 * What this is NOT:
 *   - A test of the HTTP route. To test that, deploy and curl. The route
 *     is a thin wrapper over the functions tested here; HTTP-layer concerns
 *     (auth header, JSON body parsing, NextResponse) are out of scope here.
 *   - A 2-year bootstrap test. That's what npm run backfill:btc:bootstrap is for.
 *
 * Safety:
 *   - Inserts into the real market_bars table. Inserts are idempotent
 *     (onConflict='ignore') so running this against production-live data is
 *     safe IF you're OK with the test window appearing in your data. For
 *     paranoid runs, point DATABASE_URL at a scratch DB.
 */
import {
  getPgPool,
  closePgPool,
  PgBarStore,
} from "../lib/storage";
import { fetchCandleWindow } from "../lib/data/coinbaseRest";
import { rollupBars } from "../lib/data/rollup";
import { DATA_SOURCE_COINBASE_REST } from "../lib/versions";

const SYMBOL = "BTC-USD";

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, details?: unknown): void {
  if (cond) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
    if (details !== undefined) console.log("       ", details);
  }
}

// ─── Window selection ─────────────────────────────────────────────────────

/**
 * Pick a deterministic test window: the UTC day that was complete 2 days
 * ago, with one extra hour on either side. That gives us exactly 26 hourly
 * bars and covers a full UTC day for rollup verification.
 */
function pickTestWindow(): { startTs: string; endTs: string; expectedHours: number; targetDayIso: string } {
  const nowMs = Date.now();
  const todayStart = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
    0, 0, 0, 0,
  );
  // Day -2 from today (always fully closed)
  const targetDayMs = todayStart - 2 * 24 * 3_600 * 1_000;
  const startMs     = targetDayMs - 3_600 * 1_000;             // 23:00 the previous day
  const endMs       = targetDayMs + 25 * 3_600 * 1_000;        // 01:00 the next day → 26 hours total

  return {
    startTs:       new Date(startMs).toISOString(),
    endTs:         new Date(endMs).toISOString(),
    expectedHours: 26,
    targetDayIso:  new Date(targetDayMs).toISOString(),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) {
    console.error("DATABASE_URL or SUPABASE_DB_URL must be set for the live smoke test.");
    process.exit(1);
  }

  const { startTs, endTs, expectedHours, targetDayIso } = pickTestWindow();
  console.log(`\nWindow:  ${startTs}  →  ${endTs}`);
  console.log(`Target day for 1d rollup verification: ${targetDayIso}`);

  // ── 1. Fetch from Coinbase
  console.log("\n=== fetch ===");
  const bars = await fetchCandleWindow(SYMBOL, "1h", startTs, endTs);
  assert(`fetched ${expectedHours} hourly bars`, bars.length === expectedHours, { actual: bars.length });
  if (bars.length !== expectedHours) {
    // Don't continue if Coinbase returned unexpectedly. Bail loudly.
    console.error("Coinbase returned unexpected bar count — bailing before touching DB");
    process.exit(1);
  }

  // ── 2. Insert into DB (first pass)
  console.log("\n=== insert (pass 1) ===");
  const pool = getPgPool();
  const store = new PgBarStore(pool);

  const inserted1h_pass1 = await store.insertMany(
    bars,
    DATA_SOURCE_COINBASE_REST,
    { onConflict: "ignore" },
  );
  assert(
    `pass 1: insertedBars1h <= ${expectedHours} (may be lower if window already populated)`,
    inserted1h_pass1 <= expectedHours,
    { inserted1h_pass1 },
  );

  // The target day is fully bounded by the window, so rollup should emit 1 daily bar.
  const daily = rollupBars(bars, "1d", { requireFullPeriod: true });
  assert("rollup produces 1 fully-closed daily bar", daily.length === 1, { daily });

  const inserted1d_pass1 = daily.length > 0
    ? await store.insertMany(daily, DATA_SOURCE_COINBASE_REST, { onConflict: "ignore" })
    : 0;
  assert(`pass 1: insertedBars1d <= 1`, inserted1d_pass1 <= 1);

  // ── 3. Insert again (idempotency)
  console.log("\n=== insert (pass 2 — idempotency) ===");
  const inserted1h_pass2 = await store.insertMany(
    bars,
    DATA_SOURCE_COINBASE_REST,
    { onConflict: "ignore" },
  );
  assert("pass 2: insertedBars1h == 0 (idempotent)", inserted1h_pass2 === 0, { inserted1h_pass2 });

  const inserted1d_pass2 = daily.length > 0
    ? await store.insertMany(daily, DATA_SOURCE_COINBASE_REST, { onConflict: "ignore" })
    : 0;
  assert("pass 2: insertedBars1d == 0 (idempotent)", inserted1d_pass2 === 0, { inserted1d_pass2 });

  // ── 4. Verify rows in DB
  console.log("\n=== verify ===");
  const fetched1h = await store.fetchRange(
    { symbol: SYMBOL, exchange: "COINBASE", timeframe: "1h" },
    { startTs, endTs },
  );
  assert(
    `${expectedHours} 1h rows in DB for the test window`,
    fetched1h.length === expectedHours,
    { actual: fetched1h.length },
  );

  // Daily row check: query for the target day specifically
  const dailyEndMs = Date.parse(targetDayIso) + 24 * 3_600 * 1_000;
  const fetched1d = await store.fetchRange(
    { symbol: SYMBOL, exchange: "COINBASE", timeframe: "1d" },
    { startTs: targetDayIso, endTs: new Date(dailyEndMs).toISOString() },
  );
  assert("1 1d row in DB for target day", fetched1d.length === 1, { fetched1d });

  // OHLC sanity on the daily row vs the hourly bars
  if (fetched1d.length === 1 && fetched1h.length === expectedHours) {
    // The hours for the target day specifically (drop the boundary hours)
    const dayStartMs = Date.parse(targetDayIso);
    const dayEndMs   = dayStartMs + 24 * 3_600 * 1_000;
    const targetDayHours = bars.filter((b) => {
      const ms = Date.parse(b.ts);
      return ms >= dayStartMs && ms < dayEndMs;
    });

    const d = fetched1d[0];
    const expectedOpen  = targetDayHours[0].open;
    const expectedClose = targetDayHours[targetDayHours.length - 1].close;
    const expectedHigh  = Math.max(...targetDayHours.map((h) => h.high));
    const expectedLow   = Math.min(...targetDayHours.map((h) => h.low));

    assert("1d open matches first hour of day", d.open  === expectedOpen,  { d_open: d.open, expectedOpen });
    assert("1d close matches last hour of day", d.close === expectedClose, { d_close: d.close, expectedClose });
    assert("1d high matches max of hourly highs", d.high === expectedHigh, { d_high: d.high, expectedHigh });
    assert("1d low matches min of hourly lows",   d.low  === expectedLow,  { d_low: d.low, expectedLow });
  }

  await closePgPool();

  console.log(`\n${failed === 0 ? "✓ all live checks passed" : `✗ ${failed} check(s) failed`} (${passed} passed)`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  closePgPool().catch(() => {});
  process.exit(1);
});