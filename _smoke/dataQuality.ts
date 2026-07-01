import { validateBarQuality } from "@/lib/dataQuality/barQuality";
import {
  assertCompatibleMarketIdentity,
  normalizeMarketIdentity,
} from "@/lib/dataQuality/marketIdentity";
import { handleRegimeCompute } from "@/lib/jobs/handlers/regimeCompute";
import { handleStrategiesEvaluate } from "@/lib/jobs/handlers/strategiesEvaluate";
import { assertNoLiveExecutionJobTypes, FORBIDDEN_LIVE_JOB_TYPES, JOB_TYPES, type JobPayload } from "@/lib/jobs";
import type { JobRecord, JobStore, JobEventRecord, JobRetryPolicy, RecoverExpiredJobsResult } from "@/lib/jobs/jobStore";
import type { JobHandlerServices } from "@/lib/jobs/handlers";
import { runDashboardRefreshPipeline } from "@/lib/pipeline";
import type { CacheSnapshot } from "@/lib/indicatorCache";
import type { CacheSnapshot1d } from "@/lib/indicatorCache1d";
import type { Bar, FeatureSnapshot } from "@/lib/quant/types";
import type { RegimeSnapshotRow } from "@/lib/storage";
import { InMemorySignalStore } from "@/lib/storage";
import type { IndicatorValues } from "@/lib/taapi";

let failed = 0;

function assert(label: string, cond: boolean, details?: unknown): void {
  if (!cond) {
    console.log(`FAIL: ${label}`);
    if (details !== undefined) console.log("       ", details);
    failed++;
  } else {
    console.log(`PASS: ${label}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? undefined : { actual, expected });
}

function job(payload: JobPayload, id = 1): JobRecord {
  return {
    id,
    publicId: `job_${id}`,
    jobType: payload.jobType,
    status: "queued",
    priority: 100,
    payload,
    result: null,
    dedupeKey: null,
    runAfter: "2026-06-17T10:00:00.000Z",
    attempts: 0,
    maxAttempts: 3,
    lockedBy: null,
    lockedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    error: null,
    createdAt: "2026-06-17T10:00:00.000Z",
    updatedAt: "2026-06-17T10:00:00.000Z",
  };
}

class FakeJobStore implements JobStore {
  async enqueueJob(): Promise<JobRecord> { throw new Error("not needed"); }
  async fetchJob(): Promise<JobRecord | null> { return null; }
  async listJobs(): Promise<JobRecord[]> { return []; }
  async claimNextJob(): Promise<JobRecord | null> { return null; }
  async recoverExpiredJobs(): Promise<RecoverExpiredJobsResult> { return { requeued: [], dead: [] }; }
  async heartbeatJob(): Promise<JobRecord> { throw new Error("not needed"); }
  async completeJob(): Promise<JobRecord> { throw new Error("not needed"); }
  async failJob(): Promise<JobRecord> { throw new Error("not needed"); }
  async cancelJob(): Promise<JobRecord> { throw new Error("not needed"); }
  async appendJobEvent(): Promise<JobEventRecord> {
    return { id: 1, jobId: 1, eventType: "noop", message: null, metadata: {}, createdAt: new Date().toISOString() };
  }
}

function bar(fields: Partial<Bar> = {}): Bar {
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: "2026-06-17T11:00:00.000Z",
    open: 100,
    high: 105,
    low: 99,
    close: 104,
    volume: 10,
    tradeCount: null,
    ...fields,
  };
}

function feature(ts: string, fields: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts,
    close: 104,
    rsi14: 58,
    macd: 1,
    macdSignal: 0.5,
    macdHist: 0.5,
    ema20: 100,
    ema50: 95,
    ema200: 90,
    ema20Slope: 1,
    ema50Slope: 1,
    ema200Slope: 0.5,
    atr14: 2,
    atrPct: 1.923,
    bbUpper: 110,
    bbMiddle: 100,
    bbLower: 90,
    bbWidth: 0.2,
    bbWidthPrev: 0.18,
    relativeVolume20: null,
    candleRangeAtr: 1.2,
    daily_ema50AboveEma200: true,
    daily_priceAboveEma200: true,
    featureVersion: "features.test.v1",
    ...fields,
  };
}

function dailyFeature(ts: string, fields: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return feature(ts, {
    timeframe: "1d",
    ts,
    close: 104,
    ema50: 95,
    ema200: 90,
    featureVersion: "features.test.v1",
    ...fields,
  });
}

function fakeFeatureStore(input: {
  latest1h?: FeatureSnapshot | null;
  latest1d?: FeatureSnapshot | null;
  range1h?: FeatureSnapshot[];
  range1d?: FeatureSnapshot[];
}): NonNullable<JobHandlerServices["featureStore"]> {
  return {
    async insert(snapshot) {
      return { id: 1, ...snapshot };
    },
    async insertMany() {
      return 0;
    },
    async fetchRange(filter) {
      return filter.timeframe === "1d" ? input.range1d ?? [] : input.range1h ?? [];
    },
    async fetchLatest(filter) {
      if (filter.timeframe === "1d") return input.latest1d ?? null;
      return input.latest1h ?? null;
    },
  };
}

function fakeRegimeStore(): {
  rows: Array<RegimeSnapshotRow & { id: number }>;
  store: NonNullable<JobHandlerServices["regimeStore"]>;
} {
  const rows: Array<RegimeSnapshotRow & { id: number }> = [];
  return {
    rows,
    store: {
      async insert(row) {
        const persisted = { id: rows.length + 1, ...row };
        rows.push(persisted);
        return persisted;
      },
      async latest() {
        return rows.at(-1) ?? null;
      },
      async fetchRecent() {
        return [...rows].reverse();
      },
      async latestAsContext() {
        const row = rows.at(-1);
        return row ? { regime: row.regime, reliability: row.reliability, ts: row.ts } : null;
      },
    },
  };
}

function indicator(symbol: string): IndicatorValues {
  return {
    symbol,
    rsi: 58,
    macd: { valueMACD: 1, valueMACDSignal: 0.5, valueMACDHist: 0.5 },
    ema20: 100,
    ema50: 95,
    ema200: 90,
    bb: { valueLowerBand: 90, valueMiddleBand: 100, valueUpperBand: 110 },
    bb_width: 0.2,
    bb_width_prev: 0.18,
    atr: 2,
    prevRsi: 55,
    prevHist: 0.3,
    prevEma20: 99,
    prevEma50: 94,
    prevEma200: 89,
    currentClose: 104,
    volume: 1000,
    prevVolume: 900,
    volumeSma20: 950,
    high: 105,
    low: 101,
    open: 102,
    atrAvg20: 1.8,
  };
}

function snapshot1h(): CacheSnapshot {
  const ind = indicator("BTC");
  return {
    lastUpdated: "2026-06-17T10:00:00.000Z",
    refreshing: false,
    lastFetchFailed: false,
    stockSymbols: [],
    cryptoSymbols: ["BTC"],
    data: new Map([[
      "BTC",
      {
        indicators: ind,
        quote: { symbol: "BTC", price: 104, change: 2, changePct: 1.96, changeUp: true, volume: 1000 },
        derived: {
          priceAboveEma20: true,
          ema20Slope: 1,
          ema20PctDist: 4,
          histChange: 0.2,
          rsiChange: 3,
          volumeChangePct: 11.11,
          relativeVolume: null,
          volumeExpanding: true,
          volumeAboveAverage: null,
          atrPct: 1.923,
          distanceFromEmaInAtr: 2,
          candleRangeInAtr: 2,
        },
      },
    ]]),
  };
}

function snapshot1d(): CacheSnapshot1d {
  const ind = indicator("BTC");
  return {
    lastUpdated: "2026-06-17T10:00:00.000Z",
    refreshing: false,
    lastFetchFailed: false,
    stockSymbols: [],
    cryptoSymbols: ["BTC"],
    data: new Map([[
      "BTC",
      {
        indicators: ind,
        quote: { symbol: "BTC", price: 104, change: 2, changePct: 1.96, changeUp: true, volume: 1000 },
        derived: {
          priceAboveEma50: true,
          priceAboveEma200: true,
          ema50AboveEma200: true,
          ema50Slope: 1,
          ema200Slope: 1,
        },
      },
    ]]),
  };
}

function runBarQualityChecks(): void {
  console.log("\n=== bar and market quality ===");
  const now = new Date("2026-06-17T12:05:00.000Z");
  const expected = normalizeMarketIdentity({ symbol: "BTC-USD", exchange: "COINBASE", source: "coinbase" });

  eq("valid closed bar passes quality checks", validateBarQuality({
    bar: bar(),
    expectedIdentity: expected,
    timeframe: "1h",
    now,
    closedBarsOnly: true,
    volumePolicy: "required",
    source: "coinbase",
  }).severity, "pass");
  eq("incomplete current 1H bar is rejected", validateBarQuality({
    bar: bar({ ts: "2026-06-17T12:00:00.000Z" }),
    expectedIdentity: expected,
    timeframe: "1h",
    now,
    closedBarsOnly: true,
    volumePolicy: "required",
    source: "coinbase",
  }).severity, "block");
  assert("missing OHLC blocks the bar", !validateBarQuality({
    bar: { ...bar(), open: undefined },
    expectedIdentity: expected,
    timeframe: "1h",
    now,
    closedBarsOnly: true,
    volumePolicy: "required",
    source: "coinbase",
  }).ok);
  assert("high below low blocks the bar", !validateBarQuality({
    bar: bar({ high: 98 }),
    expectedIdentity: expected,
    timeframe: "1h",
    now,
    closedBarsOnly: true,
    volumePolicy: "required",
    source: "coinbase",
  }).ok);
  assert("close outside high/low blocks the bar", !validateBarQuality({
    bar: bar({ close: 108 }),
    expectedIdentity: expected,
    timeframe: "1h",
    now,
    closedBarsOnly: true,
    volumePolicy: "required",
    source: "coinbase",
  }).ok);
  assert("missing volume blocks when required", !validateBarQuality({
    bar: bar({ volume: null }),
    expectedIdentity: expected,
    timeframe: "1h",
    now,
    closedBarsOnly: true,
    volumePolicy: "required",
    source: "coinbase",
  }).ok);
  const optionalVolume = validateBarQuality({
    bar: bar({ volume: null }),
    expectedIdentity: expected,
    timeframe: "1h",
    now,
    closedBarsOnly: true,
    volumePolicy: "optional_unavailable",
    source: "coinbase",
  });
  eq("missing volume warns when explicitly optional", optionalVolume.severity, "warn");
  assert("missing volume optional remains usable", optionalVolume.ok);

  const usdtIdentity = normalizeMarketIdentity({ symbol: "BTC/USDT", exchange: "BINANCE", source: "taapi" });
  const mismatch = assertCompatibleMarketIdentity(expected, usdtIdentity);
  assert("BTC/USDT and BTC-USD mismatch is detected", mismatch.some((issue) => issue.severity === "block"), mismatch);
}

async function runRegimeQualityChecks(): Promise<void> {
  console.log("\n=== regime data quality behavior ===");
  const payload: Extract<JobPayload, { jobType: "regime.compute" }> = {
    jobType: "regime.compute",
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
    regimeModelVersion: "requested.regime.test.v1",
    source: "persisted_features",
  };

  const staleRows = fakeRegimeStore();
  const staleResult = await handleRegimeCompute(payload, {
    workerId: "smoke",
    job: job(payload),
    store: new FakeJobStore(),
    now: () => new Date("2026-06-17T12:05:00.000Z"),
    services: {
      featureStore: fakeFeatureStore({
        latest1h: feature("2026-06-17T08:00:00.000Z"),
        latest1d: dailyFeature("2026-06-16T00:00:00.000Z"),
      }),
      regimeStore: staleRows.store,
    },
  });
  assert("stale 1H regime.compute succeeds", staleResult.success);
  eq("stale 1H persists safe CHOP", staleRows.rows[0].regime, "CHOP");
  assert("stale 1H reliability is low", staleRows.rows[0].reliability <= 0.25, staleRows.rows[0]);

  const reducedRows = fakeRegimeStore();
  const reducedResult = await handleRegimeCompute(payload, {
    workerId: "smoke",
    job: job(payload),
    store: new FakeJobStore(),
    now: () => new Date("2026-06-17T12:05:00.000Z"),
    services: {
      featureStore: fakeFeatureStore({
        latest1h: feature("2026-06-17T11:00:00.000Z"),
        latest1d: null,
      }),
      regimeStore: reducedRows.store,
    },
  });
  assert("missing 1D regime.compute succeeds", reducedResult.success);
  assert("missing 1D caps reliability", reducedRows.rows[0].reliability <= 0.55, reducedRows.rows[0]);
  if (reducedResult.success) {
    const result = reducedResult.result as { dataQuality?: { issues?: Array<{ code: string }> } };
    assert("missing 1D adds reduced-context warning", result.dataQuality?.issues?.some((issue) => issue.code === "FEATURE_MISSING") === true, result);
  }
}

async function runStrategyQualityChecks(): Promise<void> {
  console.log("\n=== strategy data quality behavior ===");
  const payload: Extract<JobPayload, { jobType: "strategies.evaluate" }> = {
    jobType: "strategies.evaluate",
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
  };
  const result = await handleStrategiesEvaluate(payload, {
    workerId: "smoke",
    job: job(payload),
    store: new FakeJobStore(),
    now: () => new Date("2026-06-17T12:05:00.000Z"),
    services: {
      featureStore: fakeFeatureStore({
        range1h: [
          feature("2026-06-17T07:00:00.000Z"),
          feature("2026-06-17T08:00:00.000Z"),
        ],
        range1d: [],
      }),
      regimeStore: fakeRegimeStore().store,
      signalStore: new InMemorySignalStore(),
    },
  });
  assert("strategies.evaluate succeeds with safe skip", result.success);
  if (result.success) {
    const body = result.result as {
      signalsEvaluated: number;
      dataQuality?: { symbolsBlocked?: number };
      symbols?: Record<string, { skipped?: boolean }>;
    };
    eq("stale strategy window emits no signals", body.signalsEvaluated, 0);
    eq("stale strategy window marks symbol blocked", body.dataQuality?.symbolsBlocked, 1);
    eq("stale strategy window skips symbol", body.symbols?.["BTC-USD"]?.skipped, true);
  }
}

async function runDashboardQualityChecks(): Promise<void> {
  console.log("\n=== dashboard data quality behavior ===");
  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  const oldOpenAIEnabled = process.env.OPENAI_ENABLED;
  process.env.OPENAI_ENABLED = "false";
  delete process.env.OPENAI_API_KEY;

  const result = await runDashboardRefreshPipeline({
    cache: {
      async forceRefresh() {},
      read: snapshot1h,
    },
    cache1d: {
      async forceRefresh() {},
      read: snapshot1d,
    },
    writeMemCache: false,
    sleepMs: async () => {},
    now: () => new Date("2026-06-17T10:00:05.000Z"),
    nowMs: () => Date.parse("2026-06-17T10:00:05.000Z"),
    runConfluenceEngineFn: async () => [],
  });

  assert("dashboard.snapshot includes dataQuality metadata", result.ok && !!result.body.dataQuality);
  if (result.ok) {
    eq("dashboard dataQuality symbol is canonical", !!result.body.dataQuality.symbols["BTC-USD"], true);
    assert(
      "dashboard flags mixed TAAPI/Yahoo context",
      result.body.dataQuality.issues.some((issue) => issue.code === "DASHBOARD_PROVIDER_MIXED_CONTEXT"),
      result.body.dataQuality,
    );
  }

  if (oldOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldOpenAIKey;
  if (oldOpenAIEnabled === undefined) delete process.env.OPENAI_ENABLED;
  else process.env.OPENAI_ENABLED = oldOpenAIEnabled;
}

async function runPersistedDashboardQualityChecks(): Promise<void> {
  console.log("\n=== dashboard.snapshot persisted feature data quality behavior (P10B) ===");
  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  const oldOpenAIEnabled = process.env.OPENAI_ENABLED;
  process.env.OPENAI_ENABLED = "false";
  delete process.env.OPENAI_API_KEY;

  const result = await runDashboardRefreshPipeline({
    cache: {
      async forceRefresh() {},
      read: snapshot1h,
    },
    cache1d: {
      async forceRefresh() {},
      read: snapshot1d,
    },
    writeMemCache: false,
    sleepMs: async () => {},
    waitBefore1dMs: 0,
    dataSource: "persisted_feature_snapshots",
    logPrefix: "[dashboard.snapshot]",
    now: () => new Date("2026-06-17T10:00:05.000Z"),
    nowMs: () => Date.parse("2026-06-17T10:00:05.000Z"),
    runConfluenceEngineFn: async () => [],
  });

  assert("persisted dashboard.snapshot includes dataQuality metadata", result.ok && !!result.body.dataQuality);
  if (result.ok) {
    assert(
      "persisted dashboard.snapshot does not flag mixed TAAPI/Yahoo context",
      !result.body.dataQuality.issues.some((issue) => issue.code === "DASHBOARD_PROVIDER_MIXED_CONTEXT"),
      result.body.dataQuality,
    );
    eq(
      "persisted dashboard.snapshot marketContext reads persisted feature snapshots",
      result.body.marketContext.dashboardDisplay.providers,
      ["coinbase"],
    );
  }

  if (oldOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldOpenAIKey;
  if (oldOpenAIEnabled === undefined) delete process.env.OPENAI_ENABLED;
  else process.env.OPENAI_ENABLED = oldOpenAIEnabled;
}

function runLiveExecutionCheck(): void {
  console.log("\n=== no live execution boundary ===");
  assertNoLiveExecutionJobTypes();
  assert("no live execution job types introduced", JOB_TYPES.every((jobType) => !FORBIDDEN_LIVE_JOB_TYPES.includes(jobType as never)));
}

async function main(): Promise<void> {
  runBarQualityChecks();
  await runRegimeQualityChecks();
  await runStrategyQualityChecks();
  await runDashboardQualityChecks();
  await runPersistedDashboardQualityChecks();
  runLiveExecutionCheck();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
