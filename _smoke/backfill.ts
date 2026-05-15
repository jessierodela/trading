/**
 * _smoke/backfill.ts
 *
 * In-memory smoke test for P2B helpers. Exercises:
 *   - fetchCandleWindow column-order mapping
 *   - fetchCandleWindow oversize window rejection
 *   - fetchCandleWindow descending-input → ascending-output sort
 *   - rollupBars OHLCV math
 *   - rollupBars partial-period gate
 *   - rollupBars null-volume handling
 *
 * NOT covered here (run manually against a deployed route + DB):
 *   - The POST /api/backfill/btc route end-to-end
 *   - PgBarStore insert path
 *   - Resume-cursor behavior under real Coinbase latency
 *
 * Usage:
 *   npx tsx _smoke/backfill.ts
 */
import {
  fetchCandleWindow,
  MAX_CANDLES_PER_REQUEST,
  CoinbaseRestError,
} from "../lib/data/coinbaseRest";
import { rollupBars } from "../lib/data/rollup";
import type { Bar } from "../lib/quant/types";

// ─── Assertion harness ────────────────────────────────────────────────────

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

function eq(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? undefined : { actual, expected });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

/**
 * Build a stubbed Response that returns the given JSON body with status 200.
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, body = ""): Response {
  return new Response(body, { status });
}

/** A 1h bar at the given ISO hour. */
function bar1h(tsIso: string, ohlcv: { o: number; h: number; l: number; c: number; v: number | null }): Bar {
  return {
    symbol:    "BTC-USD",
    exchange:  "COINBASE",
    timeframe: "1h",
    ts:        tsIso,
    open:      ohlcv.o,
    high:      ohlcv.h,
    low:       ohlcv.l,
    close:     ohlcv.c,
    volume:    ohlcv.v,
    tradeCount: null,
  };
}

// ─── coinbaseRest tests ───────────────────────────────────────────────────

async function testCoinbaseRest(): Promise<void> {
  console.log("\n=== coinbaseRest ===");

  // 1. Column-order mapping. Coinbase returns [time, low, high, open, close, volume].
  //    A common bug would be to assume OHLC ordering. Verify the mapping is L/H/O/C.
  const ts1 = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000;   // 2026-01-01T00:00:00Z
  const ts2 = ts1 + 3600;
  const stubbedFetch1: typeof fetch = async () => jsonResponse([
    // [time, low, high, open, close, volume] — DESCENDING from Coinbase
    [ts2, 100, 110, 101, 109, 5.0],
    [ts1, 90,  100, 91,  99,  3.0],
  ]);

  const bars = await fetchCandleWindow(
    "BTC-USD",
    "1h",
    new Date(ts1 * 1000).toISOString(),
    new Date((ts1 + 7200) * 1000).toISOString(),
    { fetchImpl: stubbedFetch1 },
  );

  eq("fetched count", bars.length, 2);
  eq("ascending order", bars[0].ts < bars[1].ts, true);

  const b0 = bars[0];
  eq("first bar open",   b0.open,   91);
  eq("first bar high",   b0.high,   100);
  eq("first bar low",    b0.low,    90);
  eq("first bar close",  b0.close,  99);
  eq("first bar volume", b0.volume, 3.0);
  eq("first bar symbol",   b0.symbol,    "BTC-USD");
  eq("first bar exchange", b0.exchange,  "COINBASE");
  eq("first bar timeframe", b0.timeframe, "1h");

  // 2. Oversize window must be rejected client-side before network call
  let oversizeFetchCalled = false;
  const stubbedFetchOversize: typeof fetch = async () => {
    oversizeFetchCalled = true;
    return jsonResponse([]);
  };
  // 301 hours = 301 candles > 300 max
  const oversizeStart = new Date(ts1 * 1000).toISOString();
  const oversizeEnd   = new Date((ts1 + 301 * 3600) * 1000).toISOString();
  let oversizeThrew = false;
  try {
    await fetchCandleWindow("BTC-USD", "1h", oversizeStart, oversizeEnd, {
      fetchImpl: stubbedFetchOversize,
    });
  } catch (err) {
    oversizeThrew = err instanceof CoinbaseRestError;
  }
  assert("oversize window throws CoinbaseRestError", oversizeThrew);
  assert("oversize window does not call fetch", !oversizeFetchCalled);

  // 3. HTTP error becomes CoinbaseRestError with status
  const stubbedFetch429: typeof fetch = async () => errorResponse(429, "rate limited");
  let rateLimitErr: CoinbaseRestError | null = null;
  try {
    await fetchCandleWindow(
      "BTC-USD",
      "1h",
      new Date(ts1 * 1000).toISOString(),
      new Date((ts1 + 3600) * 1000).toISOString(),
      { fetchImpl: stubbedFetch429 },
    );
  } catch (err) {
    if (err instanceof CoinbaseRestError) rateLimitErr = err;
  }
  assert("429 response throws CoinbaseRestError", rateLimitErr !== null);
  eq("error preserves status", rateLimitErr?.status, 429);

  // 4. Malformed body throws clearly (catches API drift)
  const stubbedFetchBadShape: typeof fetch = async () => jsonResponse([[ts1, 1, 2, 3]]);   // wrong arity
  let shapeErr: CoinbaseRestError | null = null;
  try {
    await fetchCandleWindow(
      "BTC-USD",
      "1h",
      new Date(ts1 * 1000).toISOString(),
      new Date((ts1 + 3600) * 1000).toISOString(),
      { fetchImpl: stubbedFetchBadShape },
    );
  } catch (err) {
    if (err instanceof CoinbaseRestError) shapeErr = err;
  }
  assert("malformed tuple throws CoinbaseRestError", shapeErr !== null);

  // 4b. PARTIAL API drift — first tuple valid, second invalid.
  //     The original "sample-first" validator missed this. Now every tuple checked.
  const stubbedFetchPartialDrift: typeof fetch = async () => jsonResponse([
    [ts2, 100, 110, 101, 109, 5.0],
    [ts1, 90, 100],                    // wrong arity — was previously silently passed
  ]);
  let partialDriftErr: CoinbaseRestError | null = null;
  try {
    await fetchCandleWindow(
      "BTC-USD", "1h",
      new Date(ts1 * 1000).toISOString(),
      new Date((ts1 + 7200) * 1000).toISOString(),
      { fetchImpl: stubbedFetchPartialDrift },
    );
  } catch (err) {
    if (err instanceof CoinbaseRestError) partialDriftErr = err;
  }
  assert("partial API drift (bad tuple mid-array) throws", partialDriftErr !== null);

  // 4c. Non-finite numeric values rejected (NaN/Infinity in volume).
  const stubbedFetchInfinity: typeof fetch = async () => jsonResponse([
    [ts1, 90, 100, 91, 99, Infinity],
  ]);
  let nonFiniteErr: CoinbaseRestError | null = null;
  try {
    await fetchCandleWindow(
      "BTC-USD", "1h",
      new Date(ts1 * 1000).toISOString(),
      new Date((ts1 + 3600) * 1000).toISOString(),
      { fetchImpl: stubbedFetchInfinity },
    );
  } catch (err) {
    if (err instanceof CoinbaseRestError) nonFiniteErr = err;
  }
  assert("non-finite numeric value rejected", nonFiniteErr !== null);

  // 5. Empty response is fine (no throw, empty array out)
  const stubbedFetchEmpty: typeof fetch = async () => jsonResponse([]);
  const empty = await fetchCandleWindow(
    "BTC-USD",
    "1h",
    new Date(ts1 * 1000).toISOString(),
    new Date((ts1 + 3600) * 1000).toISOString(),
    { fetchImpl: stubbedFetchEmpty },
  );
  eq("empty response returns []", empty, []);

  // 5b. startMs >= endMs guard — helper enforces its own contract.
  let rangeErr: CoinbaseRestError | null = null;
  let rangeFetchCalled = false;
  const stubbedFetchRange: typeof fetch = async () => {
    rangeFetchCalled = true;
    return jsonResponse([]);
  };
  try {
    await fetchCandleWindow(
      "BTC-USD", "1h",
      new Date(ts2 * 1000).toISOString(),     // start
      new Date(ts1 * 1000).toISOString(),     // end < start
      { fetchImpl: stubbedFetchRange },
    );
  } catch (err) {
    if (err instanceof CoinbaseRestError) rangeErr = err;
  }
  assert("start >= end throws", rangeErr !== null);
  assert("start >= end does not call fetch", !rangeFetchCalled);

  // 6. MAX_CANDLES_PER_REQUEST constant is documented value
  eq("max candles constant", MAX_CANDLES_PER_REQUEST, 300);
}

// ─── rollup tests ─────────────────────────────────────────────────────────

function testRollup(): void {
  console.log("\n=== rollup ===");

  // Build 24 hourly bars for 2026-01-01.
  const day0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const hours: Bar[] = [];
  for (let h = 0; h < 24; h++) {
    const tsMs = day0 + h * 3_600 * 1000;
    hours.push(bar1h(new Date(tsMs).toISOString(), {
      o: 100 + h,
      h: 105 + h,
      l: 95 + h,
      c: 102 + h,
      v: 1.0,
    }));
  }

  // 1. Full day rollup
  const daily = rollupBars(hours, "1d");
  eq("one full day → one daily bar", daily.length, 1);
  const d = daily[0];
  eq("daily ts is day start", d.ts, new Date(day0).toISOString());
  eq("daily timeframe", d.timeframe, "1d");
  eq("daily open = first hour open", d.open, 100);          // 100 + 0
  eq("daily close = last hour close", d.close, 125);        // 102 + 23
  eq("daily high = max", d.high, 128);                       // 105 + 23
  eq("daily low = min", d.low, 95);                          // 95 + 0
  eq("daily volume = sum", d.volume, 24);

  // 2. Partial day — emit by default
  const partial = hours.slice(0, 10);
  const partialDaily = rollupBars(partial, "1d");
  eq("partial day → one bar (default behavior)", partialDaily.length, 1);

  // 3. Partial day — drop with requireFullPeriod
  const partialDailyDrop = rollupBars(partial, "1d", { requireFullPeriod: true });
  eq("partial day → 0 bars with requireFullPeriod", partialDailyDrop.length, 0);

  // 4. Two full days
  const day1 = day0 + 24 * 3_600 * 1000;
  const day2Hours: Bar[] = [];
  for (let h = 0; h < 24; h++) {
    const tsMs = day1 + h * 3_600 * 1000;
    day2Hours.push(bar1h(new Date(tsMs).toISOString(), {
      o: 200, h: 210, l: 190, c: 205, v: 2.0,
    }));
  }
  const twoDays = rollupBars([...hours, ...day2Hours], "1d");
  eq("two days → two daily bars", twoDays.length, 2);
  eq("days ordered ascending", twoDays[0].ts < twoDays[1].ts, true);

  // 5. Null volume handling — all-null inputs → null output
  const allNullVol = hours.map((b) => ({ ...b, volume: null }));
  const allNullDaily = rollupBars(allNullVol, "1d");
  eq("all-null volume rollup → null daily volume", allNullDaily[0].volume, null);

  // 6. Mixed null/non-null — sum the non-nulls
  const mixedVol = hours.map((b, i) => ({ ...b, volume: i < 12 ? 1.0 : null }));
  const mixedDaily = rollupBars(mixedVol, "1d");
  eq("mixed-null volume rollup → sum of non-nulls", mixedDaily[0].volume, 12);

  // 7. Empty input
  eq("empty input → empty output", rollupBars([], "1d"), []);

  // 8. Mixed symbol throws
  const mixedSym = [
    bar1h(hours[0].ts, { o: 1, h: 1, l: 1, c: 1, v: 1 }),
    { ...bar1h(hours[1].ts, { o: 1, h: 1, l: 1, c: 1, v: 1 }), symbol: "ETH-USD" },
  ];
  let mixedThrew = false;
  try {
    rollupBars(mixedSym, "1d");
  } catch {
    mixedThrew = true;
  }
  assert("mixed symbol input throws", mixedThrew);

  // 8b. Unsorted input throws — silent sorting would hide upstream bugs.
  const unsorted = [hours[5], hours[3], hours[7]];
  let unsortedThrew = false;
  try {
    rollupBars(unsorted, "1d");
  } catch {
    unsortedThrew = true;
  }
  assert("unsorted input throws", unsortedThrew);

  // 8c. Strictly ascending — duplicate timestamps also throw.
  const dupTs = [hours[0], hours[0]];
  let dupThrew = false;
  try {
    rollupBars(dupTs, "1d");
  } catch {
    dupThrew = true;
  }
  assert("duplicate-ts input throws (strict ascending)", dupThrew);

  // 9. Same-timeframe pass-through
  const passthrough = rollupBars(hours, "1h");
  eq("source-tf == target-tf returns input unchanged", passthrough.length, hours.length);
}

// ─── Run ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testCoinbaseRest();
  testRollup();

  console.log(`\n${failed === 0 ? "✓ all checks passed" : `✗ ${failed} check(s) failed`} (${passed} passed)`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });