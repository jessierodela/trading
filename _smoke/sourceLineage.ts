import { computeFeaturesLatest } from "@/lib/features/engine";
import { handleFeaturesCompute } from "@/lib/jobs/handlers/featuresCompute";
import { handleRegimeCompute } from "@/lib/jobs/handlers/regimeCompute";
import { handleStrategiesEvaluate } from "@/lib/jobs/handlers/strategiesEvaluate";
import { assertNoLiveExecutionJobTypes, FORBIDDEN_LIVE_JOB_TYPES, JOB_TYPES, type JobPayload } from "@/lib/jobs";
import type { JobEventRecord, JobRecord, JobStore, RecoverExpiredJobsResult } from "@/lib/jobs/jobStore";
import { buildDashboardMarketContext, runMarketIngestLatestPipeline } from "@/lib/pipeline";
import type { Bar, FeatureSnapshot } from "@/lib/quant/types";
import type { RegimeSnapshotRow } from "@/lib/storage";
import { InMemoryBarStore, InMemorySignalStore } from "@/lib/storage";
import { FEATURE_VERSION } from "@/lib/versions";
import {
  assertCompatibleMarketIdentity,
  normalizeMarketIdentity,
} from "@/lib/dataQuality/marketIdentity";
import {
  buildDerivedSourceLineage,
  sourceLineageFromBar,
  sourceLineageFromFeature,
  sourceLineageFromIdentity,
  sourceLineageQualityReport,
} from "@/lib/market";
import type { SourceLineage } from "@/lib/market";
import { buildSourceLineageAuditReport } from "@/scripts/auditSourceLineage";

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

function canonicalIdentity() {
  return normalizeMarketIdentity({
    symbol: "BTC-USD",
    exchange: "COINBASE",
    source: "coinbase",
  });
}

function usdtIdentity() {
  return normalizeMarketIdentity({
    symbol: "BTC/USDT",
    exchange: "BINANCE",
    source: "taapi",
  });
}

function coinbaseLineage(kind: SourceLineage["kind"] = "market_bar"): SourceLineage {
  return sourceLineageFromIdentity({
    identity: canonicalIdentity(),
    kind,
    dataSourceVersion: kind === "market_bar" ? "coinbase.rest.v1" : undefined,
    featureVersion: kind === "feature_snapshot" ? "features.test.v1" : undefined,
  });
}

function usdtLineage(kind: SourceLineage["kind"] = "market_bar"): SourceLineage {
  return sourceLineageFromIdentity({
    identity: usdtIdentity(),
    kind,
    dataSourceVersion: kind === "market_bar" ? "taapi.binance.v1" : undefined,
  });
}

function bar(fields: Partial<Bar> = {}): Bar {
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: "2026-06-17T11:00:00.000Z",
    open: 100,
    high: 106,
    low: 99,
    close: 104,
    volume: 10,
    tradeCount: null,
    source: "coinbase",
    vendorSymbol: "BTC-USD",
    quoteAsset: "USD",
    sourceLineage: coinbaseLineage("market_bar"),
    ...fields,
  };
}

function feature(ts: string, fields: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  const baseLineage = coinbaseLineage("market_bar");
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts,
    close: 104,
    source: "coinbase",
    vendorSymbol: "BTC-USD",
    quoteAsset: "USD",
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
    volumeSma20: 9,
    relativeVolume20: 1.1,
    distanceFromEma20Atr: 2,
    candleRangeAtr: 1.2,
    daily_ema50AboveEma200: true,
    daily_priceAboveEma200: true,
    featureVersion: "features.test.v1",
    sourceLineage: buildDerivedSourceLineage({
      kind: "feature_snapshot",
      source: "features.compute",
      transform: "features.test.v1",
      transformedAt: ts,
      identity: canonicalIdentity(),
      inputSources: [baseLineage],
      featureVersion: "features.test.v1",
    }),
    ...fields,
  };
}

function dailyFeature(ts: string, fields: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return feature(ts, {
    timeframe: "1d",
    ts,
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
}) {
  return {
    async insert(snapshot: FeatureSnapshot) {
      return { id: 1, ...snapshot };
    },
    async insertMany() {
      throw new Error("insertMany should not be called in this smoke branch");
    },
    async fetchRange(filter: { timeframe: string }) {
      return filter.timeframe === "1d" ? input.range1d ?? [] : input.range1h ?? [];
    },
    async fetchLatest(filter: { timeframe: string }) {
      if (filter.timeframe === "1d") return input.latest1d ?? null;
      return input.latest1h ?? null;
    },
  };
}

function fakeRegimeStore(): {
  rows: Array<RegimeSnapshotRow & { id: number }>;
  store: {
    insert(row: RegimeSnapshotRow): Promise<RegimeSnapshotRow & { id: number }>;
    latest(): Promise<RegimeSnapshotRow | null>;
    fetchRecent(): Promise<RegimeSnapshotRow[]>;
    latestAsContext(): Promise<{ regime: "TREND_UP"; reliability: number; ts: string }>;
  };
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
        return { regime: "TREND_UP", reliability: 0.8, ts: "2026-06-17T11:00:00.000Z" };
      },
    },
  };
}

async function runMarketAndFeatureChecks(): Promise<void> {
  console.log("\n=== market and feature lineage ===");
  const coinbase = canonicalIdentity();
  const taapi = usdtIdentity();
  eq("Coinbase BTC-USD keeps USD quote", coinbase.quoteAsset, "USD");
  eq("TAAPI BTC/USDT keeps USDT quote", taapi.quoteAsset, "USDT");
  assert(
    "BTC/USDT does not silently equal BTC-USD",
    assertCompatibleMarketIdentity(coinbase, taapi).some((issue) => issue.severity === "block"),
  );

  const store = new InMemoryBarStore();
  const ingest = await runMarketIngestLatestPipeline({
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
    source: "coinbase",
    closedBarsOnly: true,
    startTs: "2026-06-17T10:00:00.000Z",
    endTs: "2026-06-17T12:00:00.000Z",
    barStore: store,
    now: () => new Date("2026-06-17T12:05:00.000Z"),
    fetchBarsFn: async () => [bar({ sourceLineage: undefined })],
  });
  assert("market ingest succeeds with trusted bar", ingest.success && ingest.insertedBars === 1, ingest);
  const insertedBars = await store.fetchRecent({ symbol: "BTC-USD", exchange: "COINBASE", timeframe: "1h" }, 10);
  eq("market ingest attaches source lineage", insertedBars[0].sourceLineage?.provider, "coinbase");
  eq("market ingest stores quote asset", insertedBars[0].quoteAsset, "USD");

  const computed = computeFeaturesLatest(insertedBars);
  const computedFeature = computed.rows.at(-1)!;
  eq("feature compute derives feature lineage", computedFeature.sourceLineage?.kind, "feature_snapshot");
  eq("feature compute preserves quote asset", computedFeature.quoteAsset, "USD");
  eq(
    "feature lineage includes input bar lineage",
    computedFeature.sourceLineage?.inputSources?.[0]?.kind,
    "market_bar",
  );

  const mixed = sourceLineageQualityReport({
    scope: "smoke.source_lineage",
    checkedAt: "2026-06-17T12:05:00.000Z",
    expectedIdentity: coinbase,
    lineages: [computedFeature.sourceLineage, usdtLineage("feature_snapshot")],
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
  });
  assert("mixed USD/USDT lineage blocks trust", !mixed.ok && mixed.issues.some((issue) => issue.code.includes("QUOTE")), mixed);

  const legacy = sourceLineageQualityReport({
    scope: "smoke.source_lineage",
    checkedAt: "2026-06-17T12:05:00.000Z",
    expectedIdentity: coinbase,
    lineages: [undefined],
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
  });
  eq("missing legacy lineage is visible warning", legacy.severity, "warn");
}

async function runFeatureHandlerCheck(): Promise<void> {
  console.log("\n=== features.compute lineage gate ===");
  const payload: Extract<JobPayload, { jobType: "features.compute" }> = {
    jobType: "features.compute",
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
    featureVersion: FEATURE_VERSION,
  };
  const result = await handleFeaturesCompute(payload, {
    workerId: "smoke",
    job: job(payload),
    store: new FakeJobStore(),
    now: () => new Date("2026-06-17T12:05:00.000Z"),
    services: {
      barStore: {
        async insert() { throw new Error("not needed"); },
        async insertMany() { throw new Error("not needed"); },
        async fetchRange() { return []; },
        async fetchRecent() {
          return [
            bar({ ts: "2026-06-17T10:00:00.000Z", sourceLineage: coinbaseLineage("market_bar") }),
            bar({ ts: "2026-06-17T11:00:00.000Z", sourceLineage: usdtLineage("market_bar") }),
          ];
        },
        async latestTs() { return null; },
      },
      featureStore: fakeFeatureStore({}),
    },
  });
  assert("features.compute blocks mixed persisted source lineage", !result.success && result.error === "features_compute_data_quality_blocked", result);
}

async function runRegimeAndStrategyChecks(): Promise<void> {
  console.log("\n=== regime and strategy lineage ===");
  const regimePayload: Extract<JobPayload, { jobType: "regime.compute" }> = {
    jobType: "regime.compute",
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
    regimeModelVersion: "requested.regime.test.v1",
    source: "persisted_features",
  };
  const regimes = fakeRegimeStore();
  const regimeResult = await handleRegimeCompute(regimePayload, {
    workerId: "smoke",
    job: job(regimePayload),
    store: new FakeJobStore(),
    now: () => new Date("2026-06-17T12:05:00.000Z"),
    services: {
      featureStore: fakeFeatureStore({
        latest1h: feature("2026-06-17T11:00:00.000Z"),
        latest1d: dailyFeature("2026-06-16T00:00:00.000Z"),
      }),
      regimeStore: regimes.store,
    },
  });
  assert("regime.compute succeeds with lineaged features", regimeResult.success, regimeResult);
  eq("regime snapshot persists derived lineage", regimes.rows[0].sourceLineage?.kind, "regime_snapshot");
  eq("regime lineage references feature input", regimes.rows[0].sourceLineage?.inputSources?.[0]?.kind, "feature_snapshot");

  const signalStore = new InMemorySignalStore();
  const strategyPayload: Extract<JobPayload, { jobType: "strategies.evaluate" }> = {
    jobType: "strategies.evaluate",
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
    strategyIds: ["momentum_continuation"],
  };
  const previous = feature("2026-06-17T10:00:00.000Z", { macdHist: 0.1 });
  const current = feature("2026-06-17T11:00:00.000Z", {
    close: 105,
    ema20: 100,
    ema20Slope: 1,
    macdHist: 0.6,
    rsi14: 60,
    atr14: 2,
    candleRangeAtr: 1.2,
  });
  const strategyResult = await handleStrategiesEvaluate(strategyPayload, {
    workerId: "smoke",
    job: job(strategyPayload),
    store: new FakeJobStore(),
    now: () => new Date("2026-06-17T12:05:00.000Z"),
    services: {
      featureStore: fakeFeatureStore({
        range1h: [previous, current],
        range1d: [dailyFeature("2026-06-16T00:00:00.000Z")],
      }),
      regimeStore: regimes.store,
      signalStore,
    },
  });
  assert("strategies.evaluate succeeds with lineaged window", strategyResult.success, strategyResult);
  const signals = await signalStore.fetchRecentBySymbol({ symbol: "BTC-USD", exchange: "COINBASE" }, 10);
  assert("strategy emits at least one smoke signal", signals.length > 0, strategyResult);
  eq("strategy signal persists derived lineage", signals[0]?.sourceLineage?.kind, "strategy_signal");
  eq("strategy signal lineage references feature input", signals[0]?.sourceLineage?.inputSources?.[0]?.kind, "feature_snapshot");

  const featureLineage = sourceLineageFromFeature(current);
  eq("sourceLineageFromFeature round-trips feature lineage", featureLineage.kind, "feature_snapshot");
}

function runDashboardAndAuditChecks(): void {
  console.log("\n=== dashboard and audit lineage ===");
  const context = buildDashboardMarketContext("2026-06-17T12:05:00.000Z");
  eq("dashboard canonical context is Coinbase BTC-USD", context.canonicalScheduled.market.canonicalSymbol, "BTC-USD");
  eq("dashboard display context is not trusted for scheduled jobs", context.dashboardDisplay.trustedForScheduledJobs, false);
  eq("dashboard display context keeps USDT quote visible", context.dashboardDisplay.market.quoteAsset, "USDT");

  const reportOnly = buildSourceLineageAuditReport({
    checkedAt: "2026-06-17T12:05:00.000Z",
    strict: false,
    tables: [
      { table: "market_bars", totalRows: 2, missingLineageRows: 1, canonicalUsdtRows: 0 },
    ],
  });
  eq("audit report-only mode surfaces missing lineage warning", reportOnly.issues[0]?.code, "SOURCE_LINEAGE_ROWS_MISSING");

  const strictBlock = buildSourceLineageAuditReport({
    checkedAt: "2026-06-17T12:05:00.000Z",
    strict: true,
    tables: [
      { table: "market_bars", totalRows: 1, missingLineageRows: 0, canonicalUsdtRows: 1 },
    ],
  });
  assert("audit strict report marks canonical USDT issue blocked", !strictBlock.ok, strictBlock);
}

function runLiveExecutionCheck(): void {
  console.log("\n=== no live execution boundary ===");
  assertNoLiveExecutionJobTypes();
  assert("no live execution job types introduced", JOB_TYPES.every((jobType) => !FORBIDDEN_LIVE_JOB_TYPES.includes(jobType as never)));
  eq("sourceLineageFromBar can derive fallback when needed", sourceLineageFromBar(bar()).kind, "market_bar");
}

async function main(): Promise<void> {
  await runMarketAndFeatureChecks();
  await runFeatureHandlerCheck();
  await runRegimeAndStrategyChecks();
  runDashboardAndAuditChecks();
  runLiveExecutionCheck();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
