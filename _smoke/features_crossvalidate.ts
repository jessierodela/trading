/**
 * _smoke/features_crossvalidate.ts
 *
 * P2D offline cross-validation test. `npm run smoke:p2d`.
 * NO DB, NO network, NO TAAPI key. Deterministic, CI-safe.
 *
 * Two phases:
 *
 *   Phase A — comparator-logic unit tests. Hand-made inputs with known
 *     deviations prove the tolerance math and hard/soft classification are
 *     correct. These need no fixture and always run.
 *
 *   Phase B — fixture-driven validation against committed REAL captured data
 *     (fixtures/p2d/btc_1h_crossvalidation_fixture.json):
 *       1. Recompute features from fixture.localBars via the P2C engine.
 *       2. Assert recomputed features match fixture.localFeatures bit-for-bit
 *          (engine-drift guard — fails loudly if the engine changed since
 *          capture).
 *       3. crossValidate(recomputed sample, fixture.taapiReference).
 *       4. Internal volume + Bollinger naive-recompute checks.
 *       5. Exit non-zero on any hard failure / internal failure.
 *
 *     If the fixture is not present, Phase B fails LOUDLY with capture
 *     instructions. It does NOT skip and does NOT fabricate data — an
 *     uncaptured fixture means P2D is not done.
 *
 * Cross-venue note: local is Coinbase BTC-USD, TAAPI free plan is Binance
 * BTC/USDT. TAAPI is an external sanity check, not exact parity.
 */
import * as fs from "fs";
import * as path from "path";
import { computeFeaturesSegmented } from "../lib/features/engine";
import {
  crossValidate,
  validateVolumeInternally,
  validateBollingerInternally,
  TOLERANCES,
  COMPARED_INDICATORS,
  type TaapiRefValues,
  type CrossValidationReport,
  type IndicatorSummary,
} from "../lib/features/crossValidate";
import {
  DEFAULT_BACKTRACK_CHUNK,
  SAMPLE_BARS,
  TAAPI_MAX_BACKTRACK,
  isTaapiBacktrackReachable,
  requestedBacktrackEnd,
  resolveBacktrackChunk,
} from "./p2d_live_config";
import type { Bar, FeatureSnapshot, Exchange, Timeframe } from "../lib/quant/types";

// ─── Fixture shape (shared with the live writer) ────────────────────────────

export interface P2DFixtureMetadata {
  capturedAt:     string;
  localExchange:  string;
  localSymbol:    string;
  taapiExchange:  string;
  taapiSymbol:    string;
  timeframe:      Timeframe;
  featureVersion: string;
  indicators:     string[];
  sampleStartTs:  string;
  sampleEndTs:    string;
  sampledBars:    number;
  note:           string;
}

export interface P2DFixture {
  metadata:       P2DFixtureMetadata;
  localBars:      Bar[];
  localFeatures:  FeatureSnapshot[];
  taapiReference: Record<string, TaapiRefValues>;
}

export const FIXTURE_PATH = path.join(
  __dirname, "..", "fixtures", "p2d", "btc_1h_crossvalidation_fixture.json",
);

// ─── Assertion harness ──────────────────────────────────────────────────────

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

// ─── Phase A: comparator-logic unit tests (no fixture) ──────────────────────

function feat(ts: string, close: number, fields: Partial<FeatureSnapshot>): FeatureSnapshot {
  return {
    symbol: "BTC-USD", exchange: "COINBASE" as Exchange, timeframe: "1h" as Timeframe,
    ts, close, featureVersion: "test", ...fields,
  };
}

function comparatorUnitTests(): void {
  console.log("\n=== Phase A: comparator-logic unit tests ===");

  const close = 100_000;

  // EMA off by exactly 0.4% of price → pass (threshold 0.5%).
  {
    const local = [feat("2026-05-17T00:00:00.000Z", close, { ema20: close })];
    const ref: Record<string, TaapiRefValues> = {
      "2026-05-17T00:00:00.000Z": { ema20: close + close * 0.004 },
    };
    const r = crossValidate(local, ref, { ema20: TOLERANCES.ema20 });
    assert("ema20 off by 0.4% of price → pass", r.passed && r.hardFailures.length === 0, summarize(r));
  }

  // EMA off by 0.6% of price → out of tolerance. Single bar → isolated → soft
  // (not systematic at 100% of 1 bar? 1/1 = 100% > 10% → systematic → hard).
  {
    const local = [feat("2026-05-17T00:00:00.000Z", close, { ema20: close })];
    const ref: Record<string, TaapiRefValues> = {
      "2026-05-17T00:00:00.000Z": { ema20: close + close * 0.006 },
    };
    const r = crossValidate(local, ref, { ema20: TOLERANCES.ema20 });
    assert("ema20 off by 0.6% on the only bar → systematic hard", !r.passed && r.hardFailures.length === 1, summarize(r));
  }

  // One bad bar out of 20 (5% < 10%) → isolated soft, report still passes.
  {
    const local: FeatureSnapshot[] = [];
    const ref: Record<string, TaapiRefValues> = {};
    for (let i = 0; i < 20; i++) {
      const ts = `2026-05-17T${String(i).padStart(2, "0")}:00:00.000Z`;
      local.push(feat(ts, close, { ema20: close }));
      // bar 0 is off by 0.6%, the rest are exact
      ref[ts] = { ema20: i === 0 ? close + close * 0.006 : close };
    }
    const r = crossValidate(local, ref, { ema20: TOLERANCES.ema20 });
    assert("1 bad bar / 20 (5%) → isolated soft, report passes", r.passed && r.softFindings.length === 1 && r.hardFailures.length === 0, summarize(r));
  }

  // Three bad bars out of 20 (15% > 10%) → systematic hard.
  {
    const local: FeatureSnapshot[] = [];
    const ref: Record<string, TaapiRefValues> = {};
    for (let i = 0; i < 20; i++) {
      const ts = `2026-05-17T${String(i).padStart(2, "0")}:00:00.000Z`;
      local.push(feat(ts, close, { ema20: close }));
      ref[ts] = { ema20: i < 3 ? close + close * 0.006 : close };
    }
    const r = crossValidate(local, ref, { ema20: TOLERANCES.ema20 });
    assert("3 bad bars / 20 (15%) → systematic hard, report fails", !r.passed && r.hardFailures.length === 3, summarize(r));
  }

  // RSI absolute-points tolerance: off by 1.5 points → pass (threshold 2.0).
  {
    const local = [feat("2026-05-17T00:00:00.000Z", close, { rsi14: 55 })];
    const ref: Record<string, TaapiRefValues> = { "2026-05-17T00:00:00.000Z": { rsi14: 56.5 } };
    const r = crossValidate(local, ref, { rsi14: TOLERANCES.rsi14 });
    assert("rsi off by 1.5 points → pass", r.passed, summarize(r));
  }
  // RSI off by 2.5 points on the only bar → systematic hard.
  {
    const local = [feat("2026-05-17T00:00:00.000Z", close, { rsi14: 55 })];
    const ref: Record<string, TaapiRefValues> = { "2026-05-17T00:00:00.000Z": { rsi14: 57.5 } };
    const r = crossValidate(local, ref, { rsi14: TOLERANCES.rsi14 });
    assert("rsi off by 2.5 points → hard", !r.passed, summarize(r));
  }

  // macdHist sign flip near zero, magnitude within tolerance → soft, report passes.
  {
    // close=100k; tolerance 0.25% of price = 250. Diff of 2 is well within.
    const local = [feat("2026-05-17T00:00:00.000Z", close, { macdHist: 1 })];
    const ref: Record<string, TaapiRefValues> = { "2026-05-17T00:00:00.000Z": { macdHist: -1 } };
    const r = crossValidate(local, ref, { macdHist: TOLERANCES.macdHist });
    assert("macdHist sign flip near zero within tol → soft, passes", r.passed && r.softFindings.length === 1, summarize(r));
  }

  // ATR relative-band acceptance: price-normalized fails but relative passes.
  {
    // close=100k. atr local=1000, ref=1080 → absDiff=80.
    // pctOfPrice = 80/100000 = 0.0008 <= 0.003 → would pass on price anyway.
    // Make price-normalized fail: absDiff=400 (0.004 > 0.003) but relative
    // 400/1080 = 0.37 > 0.10 → both fail. Instead test the OR: absDiff=280,
    // pctOfPrice=0.0028 <= 0.003 → passes on price. Use a case where ONLY
    // relative passes: huge price so pctOfPrice tiny is trivial; instead make
    // price small. Keep it simple: verify relative-only acceptance.
    const localClose = 1000; // tiny "price" to stress price-normalized
    const local = [feat("2026-05-17T00:00:00.000Z", localClose, { atr14: 100 })];
    // absDiff = 5 → pctOfPrice = 5/1000 = 0.005 > 0.003 (price fails);
    // relative = 5/105 = 0.0476 <= 0.10 (relative passes) → overall pass.
    const ref: Record<string, TaapiRefValues> = { "2026-05-17T00:00:00.000Z": { atr14: 105 } };
    const r = crossValidate(local, ref, { atr14: TOLERANCES.atr14 });
    assert("atr passes via relative band when price-normalized fails", r.passed, summarize(r));
  }

  // Missing reference value → hard failure regardless of rate.
  {
    const local = [feat("2026-05-17T00:00:00.000Z", close, { ema20: close })];
    const ref: Record<string, TaapiRefValues> = { "2026-05-17T00:00:00.000Z": {} };
    const r = crossValidate(local, ref, { ema20: TOLERANCES.ema20 });
    assert("missing TAAPI reference → hard", !r.passed && r.hardFailures.length === 1, summarize(r));
  }

  // Null local where warmup should be done → hard failure.
  {
    const local = [feat("2026-05-17T00:00:00.000Z", close, { ema200: null })];
    const ref: Record<string, TaapiRefValues> = { "2026-05-17T00:00:00.000Z": { ema200: close } };
    const r = crossValidate(local, ref, { ema200: TOLERANCES.ema200 });
    assert("null local past warmup → hard", !r.passed && r.hardFailures.length === 1, summarize(r));
  }

  // Determinism: same inputs → identical report JSON.
  {
    const local: FeatureSnapshot[] = [];
    const ref: Record<string, TaapiRefValues> = {};
    for (let i = 0; i < 10; i++) {
      const ts = `2026-05-17T${String(i).padStart(2, "0")}:00:00.000Z`;
      local.push(feat(ts, close, { ema20: close, rsi14: 50 + i }));
      ref[ts] = { ema20: close + i, rsi14: 50 + i + 0.1 };
    }
    const a = crossValidate(local, ref, TOLERANCES);
    const b = crossValidate(local, ref, TOLERANCES);
    assert("crossValidate is deterministic (identical JSON across runs)", JSON.stringify(a) === JSON.stringify(b));
  }

  // Internal volume check catches an engine/naive mismatch.
  {
    const bars: Bar[] = [];
    const features: FeatureSnapshot[] = [];
    for (let i = 0; i < 25; i++) {
      const ts = `2026-05-17T${String(i).padStart(2, "0")}:00:00.000Z`;
      bars.push({ symbol: "BTC-USD", exchange: "COINBASE", timeframe: "1h", ts, open: 1, high: 1, low: 1, close: 1, volume: 10, tradeCount: null });
      // engine "agrees": volumeSma20 = 10 once 20 bars accumulated (i>=19)
      features.push(feat(ts, 1, { volumeSma20: i >= 19 ? 10 : null, relativeVolume20: i >= 19 ? 1 : null }));
    }
    const ok = validateVolumeInternally(features, bars);
    assert("internal volume check passes on consistent data", ok.ok, { failures: ok.failures.slice(0, 3) });

    // Now corrupt one engine value.
    const corrupted = features.map((f, i) => i === 20 ? { ...f, volumeSma20: 999 } : f);
    const bad = validateVolumeInternally(corrupted, bars);
    assert("internal volume check catches a corrupted value", !bad.ok && bad.failures.length >= 1);
  }

  // Live harness config: default must remain conservative for TAAPI free tier.
  {
    assert("live capture backtrack chunk defaults to 2", resolveBacktrackChunk({}) === 2);
    assert("live capture backtrack chunk env override is honored", resolveBacktrackChunk({ P2D_BACKTRACK_CHUNK: "5" }) === 5);
    assert("live capture default constant is 2", DEFAULT_BACKTRACK_CHUNK === 2);
  }

  // Live harness reachability must account for the buffer it will actually fetch.
  {
    const sampleOnlyStart = TAAPI_MAX_BACKTRACK - SAMPLE_BARS + 1;
    assert(
      "live reachability rejects sample+buffer beyond TAAPI max backtrack",
      !isTaapiBacktrackReachable(sampleOnlyStart),
      { requestedEnd: requestedBacktrackEnd(sampleOnlyStart), max: TAAPI_MAX_BACKTRACK },
    );
  }
}

function summarize(r: CrossValidationReport): unknown {
  return { passed: r.passed, hard: r.hardFailures.length, soft: r.softFindings.length };
}

// ─── Phase B: fixture-driven validation ─────────────────────────────────────

function printSummaryTable(summaries: IndicatorSummary[]): void {
  console.log("\n  indicator    sampled  pass  soft  hard  tolerance");
  console.log("  ----------   -------  ----  ----  ----  -------------------");
  for (const s of summaries) {
    console.log(
      `  ${s.indicator.padEnd(11)}  ${String(s.sampledBars).padStart(7)}  ` +
      `${String(s.passed).padStart(4)}  ${String(s.softFindings).padStart(4)}  ` +
      `${String(s.hardFailures).padStart(4)}  ${s.toleranceUsed}`,
    );
  }
}

function fixtureDrivenTests(): void {
  console.log("\n=== Phase B: fixture-driven validation ===");

  if (!fs.existsSync(FIXTURE_PATH)) {
    failed++;
    console.log("FAIL: fixture not present — P2D is not complete.");
    console.log(`       expected: ${FIXTURE_PATH}`);
    console.log("       capture it with REAL data:");
    console.log("       UPDATE_P2D_FIXTURE=true npm run smoke:p2d:live");
    console.log("       (requires TAAPI_API_KEY + DATABASE_URL in .env.local)");
    return;
  }

  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as P2DFixture;
  console.log(`Loaded fixture captured ${fixture.metadata.capturedAt}`);
  console.log(`  ${fixture.metadata.localSymbol}@${fixture.metadata.localExchange} vs ` +
              `${fixture.metadata.taapiSymbol}@${fixture.metadata.taapiExchange} ${fixture.metadata.timeframe}`);
  console.log(`  feature version: ${fixture.metadata.featureVersion}`);
  console.log(`  warmup+sample bars: ${fixture.localBars.length}, sampled: ${fixture.metadata.sampledBars}`);

  // 1. Recompute features from frozen bars via the P2C engine.
  const recomputed = computeFeaturesSegmented(fixture.localBars);
  assert("fixture localBars are contiguous (1 segment)", recomputed.segments.length === 1,
    { segments: recomputed.segments.length, gaps: recomputed.gaps });

  // 2. Engine-drift guard: recomputed must match frozen localFeatures exactly.
  const driftMatch = JSON.stringify(recomputed.rows) === JSON.stringify(fixture.localFeatures);
  assert("recomputed features match frozen localFeatures (no engine drift)", driftMatch);
  if (!driftMatch) {
    console.log("       fixture localFeatures do not match recomputed features —");
    console.log("       engine changed since capture; re-run");
    console.log("       UPDATE_P2D_FIXTURE=true npm run smoke:p2d:live");
  }

  // 3. crossValidate over the SAMPLED window only.
  const sampleStart = fixture.metadata.sampleStartTs;
  const sampleEnd   = fixture.metadata.sampleEndTs;
  const sample = recomputed.rows.filter((r) => r.ts >= sampleStart && r.ts <= sampleEnd);
  assert("sampled window size matches metadata", sample.length === fixture.metadata.sampledBars,
    { got: sample.length, expected: fixture.metadata.sampledBars });

  const report = crossValidate(sample, fixture.taapiReference, TOLERANCES, {
    symbol:            fixture.metadata.localSymbol,
    localExchange:     fixture.metadata.localExchange,
    referenceExchange: fixture.metadata.taapiExchange,
    timeframe:         fixture.metadata.timeframe,
    featureVersion:    fixture.metadata.featureVersion,
  });
  printSummaryTable(report.indicatorSummaries);
  console.log(`\n  hard failures: ${report.hardFailures.length}, soft findings: ${report.softFindings.length}`);

  assert("cross-validation has zero hard failures", report.hardFailures.length === 0,
    report.hardFailures.slice(0, 10));

  // 4. Internal naive-recompute checks (volume + Bollinger) over full window.
  const vol = validateVolumeInternally(recomputed.rows, fixture.localBars);
  assert(`internal volume check (${vol.passed}/${vol.checked})`, vol.ok, vol.failures.slice(0, 5));

  const bb = validateBollingerInternally(recomputed.rows, fixture.localBars);
  assert(`internal Bollinger check (${bb.passed}/${bb.checked})`, bb.ok, bb.failures.slice(0, 5));
}

// ─── Run ────────────────────────────────────────────────────────────────────

function main(): void {
  comparatorUnitTests();
  fixtureDrivenTests();

  console.log(`\n${failed === 0 ? "✓ all checks passed" : `✗ ${failed} check(s) failed`} (${passed} passed)`);
  if (failed > 0) process.exit(1);
}

main();
