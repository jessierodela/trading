/**
 * _smoke/features.ts
 *
 * Smoke test for the P2C feature engine. No DB, no network.
 *
 * Covers:
 *   - Indicator math correctness (hand-verifiable fixtures)
 *   - Per-indicator warmup behavior
 *   - Gap detection (every category from the auditor's ruling)
 *   - The critical invariant: warmup does not cross gaps in segmented mode
 *   - Determinism (same input → bit-identical output across runs)
 *   - computeFeaturesLatest suffix selection
 *
 * Usage:
 *   npx tsx _smoke/features.ts
 */
import {
  computeFeaturesLatest,
  computeFeaturesSegmented,
} from "../lib/features/engine";
import {
  validateBarSeries,
  findGaps,
  longestContiguousSuffix,
  splitIntoSegments,
  BarIntegrityError,
  NoUsableSuffixError,
} from "../lib/features/gaps";
import {
  createEma,
  createSma,
  createRsi,
  createAtr,
  createBb,
  createMacd,
} from "../lib/features/indicators";
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

function near(actual: number | null | undefined, expected: number, eps = 1e-9): boolean {
  if (actual === null || actual === undefined) return false;
  return Math.abs(actual - expected) < eps;
}

// ─── Fixture builders ─────────────────────────────────────────────────────

function ts1h(hourOffset: number, base = Date.UTC(2026, 0, 1, 0, 0, 0)): string {
  return new Date(base + hourOffset * 3_600 * 1_000).toISOString();
}

function bar(hour: number, ohlcv: { o: number; h: number; l: number; c: number; v?: number | null }): Bar {
  return {
    symbol:    "BTC-USD",
    exchange:  "COINBASE",
    timeframe: "1h",
    ts:        ts1h(hour),
    open:      ohlcv.o,
    high:      ohlcv.h,
    low:       ohlcv.l,
    close:     ohlcv.c,
    volume:    ohlcv.v ?? 1.0,
    tradeCount: null,
  };
}

/** N constant-price bars at price p. */
function constantBars(n: number, price = 100, hourStart = 0): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    out.push(bar(hourStart + i, { o: price, h: price, l: price, c: price, v: 1 }));
  }
  return out;
}

/** N monotonically rising bars. Close at hour h is base + h * step. */
function risingBars(n: number, base = 100, step = 1, hourStart = 0): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const c = base + i * step;
    out.push(bar(hourStart + i, { o: c, h: c, l: c, c, v: 1 }));
  }
  return out;
}

// ─── Indicator math ───────────────────────────────────────────────────────

function testIndicatorMath(): void {
  console.log("\n=== indicator math ===");

  // EMA of a constant series is that constant, forever after warmup.
  const ema5 = createEma(5);
  let lastEma: number | null = null;
  for (let i = 0; i < 50; i++) lastEma = ema5(42);
  assert("ema of constant series == constant", near(lastEma, 42), { lastEma });

  // EMA warmup: returns null for first n-1 inputs, then a value at input n.
  const ema3 = createEma(3);
  assert("ema3 null at bar 0", ema3(1) === null);
  assert("ema3 null at bar 1", ema3(2) === null);
  // First value at bar 2 = SMA of [1,2,3] = 2.
  const e2 = ema3(3);
  assert("ema3 first value at bar 2 = SMA seed", near(e2, 2));

  // SMA of [1,2,3,4,5] window=3 — first non-null at index 2 = mean(1,2,3)=2.
  const sma3 = createSma(3);
  assert("sma3 null at bar 0", sma3(1) === null);
  assert("sma3 null at bar 1", sma3(2) === null);
  assert("sma3 first value at bar 2 = 2", near(sma3(3), 2));
  assert("sma3 at bar 3 = 3", near(sma3(4), 3));
  assert("sma3 at bar 4 = 4", near(sma3(5), 4));

  // RSI of strictly rising series should converge to 100 (all gains, no losses).
  const rsi = createRsi(14);
  let lastRsi: number | null = null;
  for (let i = 0; i < 100; i++) lastRsi = rsi(100 + i);
  assert("rsi of monotonic up == 100", near(lastRsi, 100));

  // RSI of strictly falling should be 0.
  const rsiDown = createRsi(14);
  let lastRsiDown: number | null = null;
  for (let i = 0; i < 100; i++) lastRsiDown = rsiDown(200 - i);
  assert("rsi of monotonic down == 0", near(lastRsiDown, 0));

  // RSI of a flat (constant-price) series: avgGain=0 and avgLoss=0, so
  // the engine should return neutral 50, not overbought 100.
  const rsiFlat = createRsi(14);
  let lastRsiFlat: number | null = null;
  for (let i = 0; i < 50; i++) lastRsiFlat = rsiFlat(100);
  assert("rsi of flat (constant) series == 50", near(lastRsiFlat, 50), { lastRsiFlat });

  // RSI warmup: 14-period needs 15 closes (14 diffs).
  const rsiWarm = createRsi(14);
  let rsiFirstNonNullIndex = -1;
  for (let i = 0; i < 20; i++) {
    const v = rsiWarm(100 + i);
    if (v !== null && rsiFirstNonNullIndex < 0) rsiFirstNonNullIndex = i;
  }
  assert("rsi14 first non-null at index 14 (15th call)", rsiFirstNonNullIndex === 14, { rsiFirstNonNullIndex });

  // ATR of zero-range bars should be 0.
  const atr = createAtr(14);
  let lastAtr: number | null = null;
  for (let i = 0; i < 50; i++) lastAtr = atr(100, 100, 100);
  assert("atr of zero-range bars == 0", near(lastAtr, 0));

  // BB of constant series: middle=const, upper=middle, lower=middle (stdev=0).
  const bb = createBb(20, 2);
  let lastBb: { bbUpper: number; bbMiddle: number; bbLower: number } | null = null;
  for (let i = 0; i < 50; i++) lastBb = bb(50);
  assert("bb of constant: middle == const", near(lastBb?.bbMiddle ?? null, 50));
  assert("bb of constant: upper == middle (zero stdev)", near(lastBb?.bbUpper ?? null, 50));
  assert("bb of constant: lower == middle (zero stdev)", near(lastBb?.bbLower ?? null, 50));

  // BB warmup: 20-period, first non-null at index 19.
  const bbWarm = createBb(20, 2);
  let bbFirstNonNullIndex = -1;
  for (let i = 0; i < 25; i++) {
    if (bbWarm(100) !== null && bbFirstNonNullIndex < 0) bbFirstNonNullIndex = i;
  }
  assert("bb20 first non-null at index 19", bbFirstNonNullIndex === 19, { bbFirstNonNullIndex });

  // MACD warmup: macdHist non-null when EMA26 + 9 signal periods stable.
  // EMA26 first value at index 25; signal EMA9 of macd needs 9 more = index 33.
  const macd = createMacd(12, 26, 9);
  let macdHistFirstNonNullIndex = -1;
  for (let i = 0; i < 50; i++) {
    const v = macd(100 + i);
    if (v !== null && macdHistFirstNonNullIndex < 0) macdHistFirstNonNullIndex = i;
  }
  assert(
    "macdHist first non-null at index 33 (26+9-1-1 due to EMA seed convention)",
    macdHistFirstNonNullIndex === 33,
    { macdHistFirstNonNullIndex },
  );
}

// ─── Gap detection ────────────────────────────────────────────────────────

function testGapDetection(): void {
  console.log("\n=== gap detection ===");

  // Contiguous: zero gaps.
  const ten = risingBars(10);
  assert("contiguous series has 0 gaps", findGaps(ten).length === 0);

  // Single gap in the middle.
  const withGap = [...risingBars(5), ...risingBars(5, 200, 1, 10)];
  // Last bar of first half at hour 4, first of second half at hour 10 → missing 5,6,7,8,9
  const gaps = findGaps(withGap);
  assert("single gap detected", gaps.length === 1);
  assert("gap missing count = 5", gaps[0]?.missing === 5, { gaps });

  // Validation: mixed symbol throws.
  const mixedSym = [bar(0, { o: 1, h: 1, l: 1, c: 1 }), { ...bar(1, { o: 1, h: 1, l: 1, c: 1 }), symbol: "ETH-USD" }];
  let mixedSymThrew = false;
  try { validateBarSeries(mixedSym); } catch (e) { if (e instanceof BarIntegrityError) mixedSymThrew = true; }
  assert("validate: mixed symbol throws BarIntegrityError", mixedSymThrew);

  // Validation: duplicate ts throws.
  const dupTs = [bar(0, { o: 1, h: 1, l: 1, c: 1 }), bar(0, { o: 1, h: 1, l: 1, c: 1 })];
  let dupThrew = false;
  try { validateBarSeries(dupTs); } catch (e) { if (e instanceof BarIntegrityError) dupThrew = true; }
  assert("validate: duplicate ts throws BarIntegrityError", dupThrew);

  // Validation: misaligned ts throws.
  const misaligned = [
    bar(0, { o: 1, h: 1, l: 1, c: 1 }),
    { ...bar(0, { o: 1, h: 1, l: 1, c: 1 }), ts: "2026-01-01T01:30:00.000Z" },   // not on :00
  ];
  let misalignedThrew = false;
  try { validateBarSeries(misaligned); } catch (e) { if (e instanceof BarIntegrityError) misalignedThrew = true; }
  assert("validate: misaligned ts throws BarIntegrityError", misalignedThrew);

  // Validation: non-ascending throws.
  const descending = [bar(2, { o: 1, h: 1, l: 1, c: 1 }), bar(1, { o: 1, h: 1, l: 1, c: 1 })];
  let descThrew = false;
  try { validateBarSeries(descending); } catch (e) { if (e instanceof BarIntegrityError) descThrew = true; }
  assert("validate: non-ascending throws", descThrew);

  // longestContiguousSuffix: with a gap, suffix is the post-gap segment.
  const suffix = longestContiguousSuffix(withGap);
  assert("suffix length = 5 (post-gap segment)", suffix.length === 5);
  assert("suffix starts at hour 10", suffix[0].ts === ts1h(10), { firstTs: suffix[0].ts });

  // longestContiguousSuffix: contiguous input → whole array.
  const fullSuffix = longestContiguousSuffix(ten);
  assert("contiguous input: suffix == entire input", fullSuffix.length === 10);

  // longestContiguousSuffix: empty input throws.
  let emptyThrew = false;
  try { longestContiguousSuffix([]); } catch (e) { if (e instanceof NoUsableSuffixError) emptyThrew = true; }
  assert("empty input: longestContiguousSuffix throws NoUsableSuffixError", emptyThrew);

  // splitIntoSegments: 2 segments separated by 1 gap.
  const segments = splitIntoSegments(withGap);
  assert("splitIntoSegments: 2 segments", segments.length === 2);
  assert("segment 1 starts at hour 0", segments[0]?.startTs === ts1h(0));
  assert("segment 1 ends at hour 4",   segments[0]?.endTs   === ts1h(4));
  assert("segment 2 starts at hour 10", segments[1]?.startTs === ts1h(10));
  assert("segment 2 ends at hour 14",   segments[1]?.endTs   === ts1h(14));
}

// ─── Engine: latest entry ────────────────────────────────────────────────

function testLatest(): void {
  console.log("\n=== computeFeaturesLatest ===");

  // 300 contiguous rising bars → all indicators stable by end.
  const long = risingBars(300, 1000, 1);
  const latest = computeFeaturesLatest(long);
  assert("latest: rows count == input count", latest.rows.length === 300);
  assert("latest: featureVersion stamped", latest.featureVersion.length > 0);
  assert("latest: seriesStartTs = first input ts", latest.seriesStartTs === long[0].ts);
  assert("latest: seriesEndTs = last input ts", latest.seriesEndTs === long[long.length - 1].ts);
  assert("latest: droppedPreGapCount == 0 when contiguous", latest.droppedPreGapCount === 0);

  // ema200 should be non-null on the last row (300 > 200 warmup).
  const lastRow = latest.rows[latest.rows.length - 1];
  assert("latest: ema200 non-null on last row of 300-bar series", lastRow.ema200 !== null);
  assert("latest: ema20 non-null on last row", lastRow.ema20 !== null);
  assert("latest: rsi14 non-null on last row", lastRow.rsi14 !== null);
  // Monotonic up: RSI converges to 100.
  assert("latest: rsi14 == 100 on long monotonic up", near(lastRow.rsi14, 100));

  // With a gap, latest drops everything before the gap.
  const withGap = [...risingBars(150, 100, 1), ...risingBars(150, 500, 1, 300)];
  const latestGap = computeFeaturesLatest(withGap);
  assert("latest with gap: rows = post-gap suffix length (150)", latestGap.rows.length === 150);
  assert("latest with gap: droppedPreGapCount = 150", latestGap.droppedPreGapCount === 150);
  assert("latest with gap: seriesStartTs = post-gap first bar", latestGap.seriesStartTs === ts1h(300));

  // Empty input throws.
  let emptyThrew = false;
  try { computeFeaturesLatest([]); } catch (e) { if (e instanceof NoUsableSuffixError) emptyThrew = true; }
  assert("latest: empty input throws NoUsableSuffixError", emptyThrew);

  // Bad input throws.
  let badThrew = false;
  try {
    computeFeaturesLatest([bar(0, { o: 1, h: 1, l: 1, c: 1 }), bar(0, { o: 1, h: 1, l: 1, c: 1 })]);
  } catch (e) { if (e instanceof BarIntegrityError) badThrew = true; }
  assert("latest: duplicate ts throws BarIntegrityError", badThrew);
}

// ─── Engine: segmented entry ─────────────────────────────────────────────

function testSegmented(): void {
  console.log("\n=== computeFeaturesSegmented ===");

  // Single contiguous segment.
  const contig = risingBars(50);
  const r1 = computeFeaturesSegmented(contig);
  assert("segmented contig: 1 segment", r1.segments.length === 1);
  assert("segmented contig: gapCount = 0", r1.gapCount === 0);
  assert("segmented contig: rows = input length", r1.rows.length === 50);

  // Empty input → empty result.
  const r0 = computeFeaturesSegmented([]);
  assert("segmented empty: 0 rows", r0.rows.length === 0);
  assert("segmented empty: 0 segments", r0.segments.length === 0);
  assert("segmented empty: 0 gaps", r0.gapCount === 0);

  // ─── THE CRITICAL INVARIANT ──────────────────────────────────────────
  //
  // Warmup does NOT cross gaps. Build 500-bar series with a gap at bar
  // 300. Segment 1 = 300 bars; segment 2 = 200 bars.
  //
  // Segment 1's last row has all indicators stable (ema200 needs 200).
  // Segment 2 starts FRESH — its first row must have ema200 null even
  // though segment 1 had it fully warmed.
  //
  // This is the entire reason for the segmented entry point.
  const seg1 = risingBars(300, 100, 1, 0);
  const seg2 = risingBars(200, 1000, 1, 400);   // gap from hour 300 to hour 400
  const merged = [...seg1, ...seg2];
  const r2 = computeFeaturesSegmented(merged);

  assert("segmented w/gap: 2 segments", r2.segments.length === 2);
  assert("segmented w/gap: gapCount = 1", r2.gapCount === 1);
  assert("segmented w/gap: rows == sum of segment lengths", r2.rows.length === 500);

  // Find the row at the boundary: last of segment 1 and first of segment 2.
  const lastOfSeg1Idx = 299;
  const firstOfSeg2Idx = 300;

  // Last row of seg 1: ema200 should be non-null (300 contiguous bars).
  assert(
    "warmup NOT crossing gap: seg 1 last row has ema200 non-null",
    r2.rows[lastOfSeg1Idx].ema200 !== null,
    { ema200: r2.rows[lastOfSeg1Idx].ema200 },
  );

  // First row of seg 2: ema200 MUST be null (segment just started, warmup reset).
  assert(
    "warmup NOT crossing gap: seg 2 first row has ema200 NULL (warmup reset)",
    r2.rows[firstOfSeg2Idx].ema200 === null,
    { ema200: r2.rows[firstOfSeg2Idx].ema200 },
  );
  // Same for other slow indicators: ema50, rsi14.
  assert(
    "seg 2 first row: ema50 null (warmup reset)",
    r2.rows[firstOfSeg2Idx].ema50 === null,
  );
  assert(
    "seg 2 first row: rsi14 null (warmup reset)",
    r2.rows[firstOfSeg2Idx].rsi14 === null,
  );
  // Last row of seg 2 (200 bars in): ema200 still null (need 200, have 200, seed at index 199).
  // But ema50 (50) and rsi14 (14) should be stable.
  const lastOfSeg2 = r2.rows[r2.rows.length - 1];
  assert(
    "seg 2 last row (200 bars in): ema50 non-null",
    lastOfSeg2.ema50 !== null,
  );
  assert(
    "seg 2 last row: rsi14 non-null",
    lastOfSeg2.rsi14 !== null,
  );
  // ema200 with 200 bars: first non-null at index 199 of the segment.
  assert(
    "seg 2 last row (200th bar in segment): ema200 non-null at index 199",
    lastOfSeg2.ema200 !== null,
  );

  // Segment metadata.
  assert("seg 1 meta count = 300", r2.segments[0].count === 300);
  assert("seg 2 meta count = 200", r2.segments[1].count === 200);

  // Bad input still throws.
  let badThrew = false;
  try {
    computeFeaturesSegmented([
      bar(0, { o: 1, h: 1, l: 1, c: 1 }),
      { ...bar(1, { o: 1, h: 1, l: 1, c: 1 }), symbol: "ETH-USD" },
    ]);
  } catch (e) { if (e instanceof BarIntegrityError) badThrew = true; }
  assert("segmented: mixed symbol throws BarIntegrityError", badThrew);
}

// ─── Determinism ──────────────────────────────────────────────────────────

function testDeterminism(): void {
  console.log("\n=== determinism ===");

  // Synthetic but varied: 500 bars with mild noise.
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < 500; i++) {
    // Pure deterministic "noise" from i — no random.
    const wiggle = Math.sin(i * 0.137) * 2;
    const c = price + wiggle;
    const h = c + 0.5;
    const l = c - 0.5;
    bars.push(bar(i, { o: c, h, l, c, v: 1 + (i % 10) }));
    price += 0.1;
  }

  const r1 = computeFeaturesSegmented(bars);
  const r2 = computeFeaturesSegmented(bars);
  const r3 = computeFeaturesLatest(bars);
  const r4 = computeFeaturesLatest(bars);

  // JSON round-trip is a proxy for bit-identical here. If any indicator
  // produced even a single ULP difference between runs, JSON.stringify
  // would diverge.
  assert(
    "segmented: same input → bit-identical output across two runs",
    JSON.stringify(r1.rows) === JSON.stringify(r2.rows),
  );
  assert(
    "latest: same input → bit-identical output across two runs",
    JSON.stringify(r3.rows) === JSON.stringify(r4.rows),
  );
  // segmented and latest should produce identical features for a fully
  // contiguous input (latest's suffix == the whole input).
  assert(
    "segmented and latest agree on a fully contiguous input",
    JSON.stringify(r1.rows) === JSON.stringify(r3.rows),
  );
}

// ─── Run ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  testIndicatorMath();
  testGapDetection();
  testLatest();
  testSegmented();
  testDeterminism();

  console.log(`\n${failed === 0 ? "✓ all checks passed" : `✗ ${failed} check(s) failed`} (${passed} passed)`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
