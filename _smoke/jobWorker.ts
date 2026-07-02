import fs from "node:fs";
import path from "node:path";
import {
  assertJobHandlerRegistryComplete,
  JOB_HANDLER_REGISTRY,
  type JobHandler,
  type JobHandlerServices,
} from "@/lib/jobs/handlers";
import type {
  JobEventRecord,
  JobRecord,
  JobRetryPolicy,
  JobStatus,
  JobStore,
  RecoverExpiredJobsResult,
} from "@/lib/jobs/jobStore";
import { FORBIDDEN_LIVE_JOB_TYPES, JOB_TYPES, type JobPayload } from "@/lib/jobs/types";
import { runJobWorkerOnce } from "@/lib/jobs/worker";
import { handleDashboardSnapshot } from "@/lib/jobs/handlers/dashboardSnapshot";
import { handleMarketIngestLatest } from "@/lib/jobs/handlers/marketIngestLatest";
import { handlePaperMonitor } from "@/lib/jobs/handlers/paperMonitor";
import { handleRegimeCompute } from "@/lib/jobs/handlers/regimeCompute";
import { handleTelegramRefresh } from "@/lib/jobs/handlers/telegramRefresh";
import { isActionableTriggerSignal, runScheduledRiskGate } from "@/lib/jobs/handlers/strategiesRiskGate";
import { buildDashboardMarketContext } from "@/lib/pipeline";
import type { Bar, FeatureSnapshot, RegimeContext, StrategySignal } from "@/lib/quant/types";
import type { RegimeSnapshotRow } from "@/lib/storage";
import { InMemoryTradeIntentStore, type TradeIntent, type TradeIntentListFilter, type TradeIntentStore } from "@/lib/tradeIntent";
import { InMemoryRiskDecisionStore } from "@/lib/risk/riskDecisionStore";
import type { RiskConfig } from "@/lib/risk/types";
import { FEATURE_VERSION, RISK_VERSION, STRATEGY_VERSIONS } from "@/lib/versions";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  jobs: JobRecord[];
  events: JobEventRecord[] = [];
  recoverCalls = 0;
  heartbeatCalls = 0;
  completeCalls = 0;
  failCalls = 0;
  retryPolicies: JobRetryPolicy[] = [];

  constructor(jobs: JobRecord[] = []) {
    this.jobs = jobs;
  }

  async enqueueJob(): Promise<JobRecord> {
    throw new Error("not needed in smoke");
  }

  async fetchJob(publicId: string): Promise<JobRecord | null> {
    return this.jobs.find((j) => j.publicId === publicId) ?? null;
  }

  async listJobs(): Promise<JobRecord[]> {
    return this.jobs;
  }

  async claimNextJob(workerId: string, leaseMs: number): Promise<JobRecord | null> {
    const next = this.jobs.find((j) => j.status === "queued");
    if (!next) return null;
    next.status = "running";
    next.lockedBy = workerId;
    next.attempts += 1;
    next.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    return next;
  }

  async recoverExpiredJobs(): Promise<RecoverExpiredJobsResult> {
    this.recoverCalls += 1;
    return { requeued: [], dead: [] };
  }

  async heartbeatJob(jobId: string | number): Promise<JobRecord> {
    this.heartbeatCalls += 1;
    const found = this.jobs.find((j) => j.id === Number(jobId) || j.publicId === String(jobId));
    if (!found) throw new Error("job not found");
    return found;
  }

  async completeJob(jobId: string | number, _workerId: string, result: unknown): Promise<JobRecord> {
    this.completeCalls += 1;
    const found = this.jobs.find((j) => j.id === Number(jobId) || j.publicId === String(jobId));
    if (!found) throw new Error("job not found");
    found.status = "succeeded";
    found.result = result;
    return found;
  }

  async failJob(
    jobId: string | number,
    _workerId: string,
    error: string,
    retryPolicy: JobRetryPolicy,
  ): Promise<JobRecord> {
    this.failCalls += 1;
    this.retryPolicies.push(retryPolicy);
    const found = this.jobs.find((j) => j.id === Number(jobId) || j.publicId === String(jobId));
    if (!found) throw new Error("job not found");
    found.error = error;
    found.status = retryPolicy.retryable ? "queued" : "failed";
    return found;
  }

  async cancelJob(): Promise<JobRecord> {
    throw new Error("not needed in smoke");
  }

  async appendJobEvent(
    jobId: string | number,
    eventType: string,
    message: string | null = null,
    metadata: unknown = {},
  ): Promise<JobEventRecord> {
    const event: JobEventRecord = {
      id: this.events.length + 1,
      jobId: Number(jobId),
      eventType,
      message,
      metadata,
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }
}

function fakeBarStore(): NonNullable<JobHandlerServices["barStore"]> {
  let latest: string | null = null;
  return {
    async insert(bar: Bar) {
      latest = bar.ts;
      return { id: 1, ...bar };
    },
    async insertMany(bars: Bar[]) {
      latest = bars.at(-1)?.ts ?? latest;
      return bars.length;
    },
    async fetchRange() {
      return [];
    },
    async fetchRecent() {
      return [];
    },
    async latestTs() {
      return latest;
    },
  };
}

function fakeFeatureStore(
  feature1h: FeatureSnapshot | null,
  feature1d: FeatureSnapshot | null,
): NonNullable<JobHandlerServices["featureStore"]> {
  return {
    async insert(snapshot) {
      return { id: 1, ...snapshot };
    },
    async insertMany() {
      return 0;
    },
    async fetchRange() {
      return [];
    },
    async fetchLatest(filter) {
      if (filter.timeframe === "1h") return feature1h;
      if (filter.timeframe === "1d") return feature1d;
      return null;
    },
  };
}

function fakeRegimeStore(): {
  store: NonNullable<JobHandlerServices["regimeStore"]>;
  rows: Array<RegimeSnapshotRow & { id: number }>;
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

function fakePaperStore(): NonNullable<JobHandlerServices["paperStore"]> {
  return {
    async listPositions() {
      return [];
    },
  } as unknown as NonNullable<JobHandlerServices["paperStore"]>;
}

// ─── P11 scheduled risk gate fixtures ──────────────────────────────────────

/**
 * Mirrors the Postgres partial unique index added in 0005_risk_decisions.sql
 * (source_signal_ids, risk_version) so the idempotency smoke coverage below
 * exercises the same duplicate-key catch path the real worker relies on.
 */
class DedupingTradeIntentStore implements TradeIntentStore {
  private readonly inner = new InMemoryTradeIntentStore();
  private readonly seenKeys = new Set<string>();

  async insertIntent(intent: TradeIntent): Promise<TradeIntent> {
    if (intent.sourceSignalIds.length > 0) {
      const key = `${intent.sourceSignalIds.join(",")}|${intent.riskDecision.riskVersion}`;
      if (this.seenKeys.has(key)) {
        throw new Error('duplicate key value violates unique constraint "trade_intents_signal_risk_version_unique"');
      }
      this.seenKeys.add(key);
    }
    return this.inner.insertIntent(intent);
  }

  async fetchIntent(id: string): Promise<TradeIntent | null> {
    return this.inner.fetchIntent(id);
  }

  async listIntents(filter?: TradeIntentListFilter): Promise<TradeIntent[]> {
    return this.inner.listIntents(filter);
  }
}

function gateRiskConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    enabled: true,
    maxRiskPerTradePct: 0.01,
    maxDailyLossPct: 0.03,
    maxWeeklyLossPct: 0.08,
    maxOpenPositions: 3,
    maxSymbolExposurePct: 1,
    maxPortfolioExposurePct: 1,
    minRegimeReliability: 0.5,
    blockedRegimes: [],
    allowLong: true,
    allowShort: true,
    allowDefaultStopFallback: true,
    defaultStopLossPct: 0.02,
    defaultTakeProfitPct: 0.04,
    maxLeverage: 1,
    staleSignalMaxAgeMs: 60 * 60 * 1000,
    duplicateCooldownMs: 0,
    maxConsecutiveLosses: 3,
    highVolSizeMultiplier: 0.5,
    chopSizeMultiplier: 0.25,
    newsShockBlocksTrading: true,
    killSwitchEnabled: false,
    ...overrides,
  };
}

function gateSignal(overrides: Partial<StrategySignal> = {}, id: number): StrategySignal & { id: number } {
  const ts = overrides.ts ?? "2026-06-20T12:00:00.000Z";
  return {
    id,
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts,
    strategyId: "momentum_continuation",
    signalType: "trigger",
    direction: "long",
    confidence: 0.9,
    invalidationPrice: 98,
    stopLoss: 98,
    takeProfit: 104,
    features: {
      symbol: "BTC-USD",
      exchange: "COINBASE",
      timeframe: "1h",
      ts,
      close: 100,
      featureVersion: FEATURE_VERSION,
    },
    reasons: ["P11 risk gate smoke trigger"],
    strategyVersion: STRATEGY_VERSIONS.momentumContinuation,
    featureVersion: FEATURE_VERSION,
    ...overrides,
  };
}

function gateRegime(overrides: Partial<RegimeContext> = {}): RegimeContext {
  return { regime: "TREND_UP", reliability: 0.9, ts: "2026-06-20T12:00:00.000Z", ...overrides };
}

function gateServices(intentStore: TradeIntentStore = new InMemoryTradeIntentStore()) {
  return {
    paperStore: fakePaperStore(),
    intentStore,
    riskDecisionStore: new InMemoryRiskDecisionStore(),
  };
}

async function runStrategiesRiskGateChecks(): Promise<void> {
  console.log("\n=== P11 scheduled risk gate ===");
  const now = () => new Date("2026-06-20T12:01:00.000Z");
  const baseOptions = { now, riskConfig: gateRiskConfig(), accountEquity: 10_000 };

  {
    const setupSignal = gateSignal({ signalType: "setup" }, 101);
    const exitSignal = gateSignal({ signalType: "exit" }, 102);
    const invalidatedSignal = gateSignal({ signalType: "invalidated" }, 103);
    assert("setup signal is not classified as actionable trigger", !isActionableTriggerSignal(setupSignal));
    assert("exit signal is not classified as actionable trigger", !isActionableTriggerSignal(exitSignal));
    assert("invalidated signal is not classified as actionable trigger", !isActionableTriggerSignal(invalidatedSignal));
    assert("trigger signal is classified as actionable", isActionableTriggerSignal(gateSignal({}, 104)));

    const services = gateServices();
    const result = await runScheduledRiskGate(setupSignal, gateRegime(), services, baseOptions);
    eq("non-trigger setup signal skips risk evaluation entirely", result, {
      evaluated: false, isNewDecision: false, approved: null, intentCreated: false, decision: null,
    });
    eq("non-trigger setup signal creates no trade intent", (await services.intentStore.listIntents()).length, 0);
    eq("non-trigger setup signal creates no risk decision", (await services.riskDecisionStore.listDecisions()).length, 0);
  }

  {
    const services = gateServices();
    const signal = gateSignal({}, 201);
    const result = await runScheduledRiskGate(signal, gateRegime(), services, baseOptions);
    assert("approved trigger is evaluated and approved", result.evaluated && result.approved === true, result);
    assert("approved trigger creates a trade intent", result.intentCreated, result);

    const intents = await services.intentStore.listIntents();
    eq("approved trigger creates exactly one trade intent", intents.length, 1);
    eq("approved intent uses risk_approved status", intents[0].status, "risk_approved");
    eq("approved intent preserves risk version", intents[0].riskDecision.riskVersion, RISK_VERSION);
    assert("approved intent preserves sizing fields", intents[0].suggestedSize > 0 && intents[0].maxRiskUsd > 0, intents[0]);
    assert("approved intent preserves stop/take-profit from risk decision", intents[0].stopLoss === 98 && intents[0].takeProfit === 104, intents[0]);

    const decisions = await services.riskDecisionStore.listDecisions();
    eq("approved trigger persists exactly one risk decision", decisions.length, 1);
    assert("persisted decision is marked approved", decisions[0].decision.approved === true, decisions[0]);
  }

  {
    const services = gateServices();
    const signal = gateSignal({}, 301);
    const result = await runScheduledRiskGate(signal, gateRegime(), services, {
      ...baseOptions,
      riskConfig: gateRiskConfig({ blockedRegimes: ["TREND_UP"] }),
    });
    assert("rejected trigger is evaluated and rejected", result.evaluated && result.approved === false, result);
    assert("rejected trigger reports no intent created", !result.intentCreated, result);
    eq("rejected trigger creates zero trade intents", (await services.intentStore.listIntents()).length, 0);

    const decisions = await services.riskDecisionStore.listDecisions();
    eq("rejected trigger still persists a risk decision", decisions.length, 1);
    assert("rejected decision preserves blockedBy reasons", decisions[0].decision.blockedBy.includes("REGIME_BLOCKED"), decisions[0]);
  }

  {
    const services = gateServices();
    const signal = gateSignal({
      ts: "2026-06-20T10:00:00.000Z",
      features: {
        symbol: "BTC-USD", exchange: "COINBASE", timeframe: "1h",
        ts: "2026-06-20T10:00:00.000Z", close: 100, featureVersion: FEATURE_VERSION,
      },
    }, 401);
    const result = await runScheduledRiskGate(signal, gateRegime({ ts: "2026-06-20T10:00:00.000Z" }), services, baseOptions);
    assert("stale signal is rejected", result.approved === false && !!result.decision?.blockedBy.includes("SIGNAL_STALE"), result);
  }

  {
    const services = gateServices();
    const signal = gateSignal({ invalidationPrice: null, stopLoss: null }, 501);
    const result = await runScheduledRiskGate(signal, gateRegime(), services, {
      ...baseOptions,
      riskConfig: gateRiskConfig({ allowDefaultStopFallback: false, defaultStopLossPct: 0 }),
    });
    assert(
      "missing stop/invalidation without fallback is rejected",
      result.approved === false && !!result.decision?.blockedBy.includes("STOP_LOSS_MISSING"),
      result,
    );
  }

  {
    const services = gateServices();
    const signal = gateSignal({ invalidationPrice: null, stopLoss: null }, 601);
    const result = await runScheduledRiskGate(signal, gateRegime(), services, baseOptions);
    assert(
      "missing stop/invalidation with fallback allowed produces an explicit warning",
      !!result.decision?.warnings.includes("DEFAULT_STOP_FALLBACK_USED"),
      result,
    );
  }

  {
    const services = gateServices();
    const signal = gateSignal({}, 701);
    const result = await runScheduledRiskGate(signal, gateRegime({ regime: "CHOP" }), services, baseOptions);
    assert(
      "CHOP regime is respected: approved with reduced size and explicit warning",
      result.approved === true && !!result.decision?.warnings.includes("CHOP_SIZE_REDUCED"),
      result,
    );
  }

  {
    const services = gateServices();
    const signal = gateSignal({}, 801);
    const result = await runScheduledRiskGate(signal, gateRegime({ regime: "NEWS_SHOCK" }), services, baseOptions);
    assert(
      "NEWS_SHOCK regime is respected and blocks trading",
      result.approved === false && !!result.decision?.blockedBy.includes("NEWS_SHOCK_BLOCKED"),
      result,
    );
  }

  {
    const services = gateServices(new DedupingTradeIntentStore());
    const signal = gateSignal({}, 901);
    const first = await runScheduledRiskGate(signal, gateRegime(), services, baseOptions);
    const second = await runScheduledRiskGate(signal, gateRegime(), services, baseOptions);

    assert("first run of a signal persists a new risk decision", first.isNewDecision, first);
    assert("rerun of the same signal + risk version reuses the persisted decision", !second.isNewDecision, second);
    assert("rerun still reports the original approval outcome", second.approved === true, second);
    assert("rerun does not report a newly created intent", !second.intentCreated, second);

    const decisions = await services.riskDecisionStore.listDecisions();
    eq("rerun does not duplicate risk decisions", decisions.length, 1);
    const intents = await services.intentStore.listIntents();
    eq("rerun does not duplicate approved trade intents", intents.length, 1);
  }
}

async function runRegistryChecks(): Promise<void> {
  console.log("\n=== handler registry ===");
  assertJobHandlerRegistryComplete();
  for (const jobType of JOB_TYPES) {
    assert(`registry has ${jobType}`, typeof JOB_HANDLER_REGISTRY[jobType] === "function");
  }
}

async function runHandlerChecks(): Promise<void> {
  console.log("\n=== direct handler behavior ===");
  let marketCalled = false;
  const marketPayload: Extract<JobPayload, { jobType: "market.ingest.latest" }> = {
    jobType: "market.ingest.latest",
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
    source: "coinbase",
    closedBarsOnly: true,
  };
  const marketResult = await handleMarketIngestLatest(marketPayload, {
    workerId: "smoke",
    job: job(marketPayload),
    store: new FakeJobStore(),
    now: () => new Date("2026-06-17T12:30:00.000Z"),
    services: {
      barStore: fakeBarStore(),
      async runMarketIngestLatestPipeline(input) {
        marketCalled = true;
        eq("market handler passes closedBarsOnly", input.closedBarsOnly, true);
        eq("market handler computes latest window end", input.endTs, "2026-06-17T12:00:00.000Z");
        return {
          success: true,
          source: input.source,
          exchange: input.exchange,
          timeframe: input.timeframe,
          closedBarsOnly: true,
          fetchedBars: 1,
          insertedBars: 1,
          skippedBars: 0,
          latestTs: "2026-06-17T11:00:00.000Z",
          dataQuality: {
            ok: true,
            severity: "pass",
            checkedAt: "2026-06-17T12:00:00.000Z",
            scope: "market.ingest.latest",
            issues: [],
            summary: { pass: 1, warn: 0, block: 0 },
            checkedBars: 1,
            passedBars: 1,
            warnedBars: 0,
            blockedBars: 0,
          },
          symbols: {
            "BTC-USD": {
              fetchedBars: 1,
              insertedBars: 1,
              skippedBars: 0,
              latestTs: "2026-06-17T11:00:00.000Z",
              dataQuality: {
                ok: true,
                severity: "pass",
                checkedAt: "2026-06-17T12:00:00.000Z",
                scope: "market.ingest.latest.symbol",
                issues: [],
                summary: { pass: 1, warn: 0, block: 0 },
                checkedBars: 1,
                passedBars: 1,
                warnedBars: 0,
                blockedBars: 0,
              },
            },
          },
        };
      },
    },
  });
  assert("market handler succeeds", marketResult.success);
  eq("market handler calls ingest service", marketCalled, true);

  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  const oldOpenAIEnabled = process.env.OPENAI_ENABLED;
  const oldOpenAIRegimeEnabled = process.env.OPENAI_REGIME_ENABLED;
  const oldOpenAIStrategyAgentsEnabled = process.env.OPENAI_STRATEGY_AGENTS_ENABLED;
  delete process.env.OPENAI_API_KEY;
  process.env.OPENAI_ENABLED = "false";
  process.env.OPENAI_REGIME_ENABLED = "false";
  process.env.OPENAI_STRATEGY_AGENTS_ENABLED = "false";
  const feature1h: FeatureSnapshot = {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: "2026-06-17T11:00:00.000Z",
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
  };
  const regimeRows = fakeRegimeStore();
  let openAIDetectorCalled = false;
  const regimePayload: Extract<JobPayload, { jobType: "regime.compute" }> = {
    jobType: "regime.compute",
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
    regimeModelVersion: "requested.regime.test.v1",
    source: "persisted_features",
  };
  const regimeResult = await handleRegimeCompute(regimePayload, {
    workerId: "smoke",
    job: job(regimePayload),
    store: new FakeJobStore(),
    now: () => new Date("2026-06-17T12:00:00.000Z"),
    services: {
      featureStore: fakeFeatureStore(feature1h, null),
      regimeStore: regimeRows.store,
      async runRegimeDetector() {
        openAIDetectorCalled = true;
        throw new Error("429 insufficient_quota");
      },
    },
  });
  assert("regime compute succeeds without OpenAI key", regimeResult.success);
  eq("regime compute does not call OpenAI detector service", openAIDetectorCalled, false);
  eq("regime compute persists deterministic row", regimeRows.rows.length, 1);
  eq("regime compute marks aiUsed false", (regimeRows.rows[0].rawResponse as { aiUsed?: boolean }).aiUsed, false);
  if (regimeResult.success) {
    eq("regime compute reports deterministic mode", (regimeResult.result as { aiUsed?: boolean }).aiUsed, false);
  }

  const sparseRows = fakeRegimeStore();
  const sparseRegimeResult = await handleRegimeCompute(regimePayload, {
    workerId: "smoke",
    job: job(regimePayload),
    store: new FakeJobStore(),
    now: () => new Date("2026-06-17T12:00:00.000Z"),
    services: {
      featureStore: fakeFeatureStore(null, null),
      regimeStore: sparseRows.store,
    },
  });
  assert("regime compute persists safe fallback for missing features", sparseRegimeResult.success);
  eq("regime missing features persisted as CHOP", sparseRows.rows[0].regime, "CHOP");
  eq("regime missing features blocks trading through reliability floor", sparseRows.rows[0].tradePermission, "BLOCK");
  if (oldOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldOpenAIKey;
  if (oldOpenAIEnabled === undefined) delete process.env.OPENAI_ENABLED;
  else process.env.OPENAI_ENABLED = oldOpenAIEnabled;
  if (oldOpenAIRegimeEnabled === undefined) delete process.env.OPENAI_REGIME_ENABLED;
  else process.env.OPENAI_REGIME_ENABLED = oldOpenAIRegimeEnabled;
  if (oldOpenAIStrategyAgentsEnabled === undefined) delete process.env.OPENAI_STRATEGY_AGENTS_ENABLED;
  else process.env.OPENAI_STRATEGY_AGENTS_ENABLED = oldOpenAIStrategyAgentsEnabled;

  let dashboardRefreshCalled = false;
  let snapshotWriteCalled = false;
  const dashboardPayload: Extract<JobPayload, { jobType: "dashboard.snapshot" }> = {
    jobType: "dashboard.snapshot",
    snapshotType: "dashboard",
  };
  const dashboardResult = await handleDashboardSnapshot(dashboardPayload, {
    workerId: "smoke",
    job: job(dashboardPayload),
    store: new FakeJobStore(),
    now: () => new Date("2026-06-17T12:00:00.000Z"),
    services: {
      dashboardSnapshotStore: {} as never,
      featureStore: fakeFeatureStore(feature1h, null),
      async runDashboardRefreshPipeline(refreshInput) {
        dashboardRefreshCalled = true;
        eq("dashboard handler requests persisted feature snapshot source", refreshInput?.dataSource, "persisted_feature_snapshots");
        eq("dashboard handler skips artificial 1D wait", refreshInput?.waitBefore1dMs, 0);
        return {
          ok: true,
          status: 200,
          body: {
            success: true,
            durationMs: 5,
            agentResults: [],
            confluence: [],
            regimeMap: {},
            stats: { activeAgents: 0, alertsToday: 0, buySignals: 0, highConfidence: 0 },
            activity: [],
            generatedAt: "2026-06-17T12:00:00.000Z",
            indicators: {},
            derived: {},
            dataQuality: {
              severity: "pass",
              issues: [],
              symbols: {},
            },
            marketContext: buildDashboardMarketContext("2026-06-17T12:00:00.000Z"),
          },
        };
      },
      async writeDashboardSnapshot() {
        snapshotWriteCalled = true;
        return {
          success: true,
          skipped: false,
          snapshot: {
            id: 1,
            publicId: "snap_1",
            snapshotType: "dashboard",
            symbol: null,
            timeframe: null,
            payload: {},
            sourceJobId: 1,
            generatedAt: "2026-06-17T12:00:00.000Z",
            expiresAt: null,
            createdAt: "2026-06-17T12:00:00.000Z",
          },
        };
      },
    },
  });
  assert("dashboard handler succeeds", dashboardResult.success);
  eq("dashboard handler calls refresh service", dashboardRefreshCalled, true);
  eq("dashboard handler calls snapshot write service", snapshotWriteCalled, true);

  const paperPayload: Extract<JobPayload, { jobType: "paper.monitor" }> = {
    jobType: "paper.monitor",
    timeframe: "1h",
  };
  const telegramPayload: Extract<JobPayload, { jobType: "telegram.refresh" }> = {
    jobType: "telegram.refresh",
    chatId: "123",
    requestedBy: "telegram",
  };
  const paperMonitorResult = await handlePaperMonitor(paperPayload, {
    workerId: "smoke",
    job: job(paperPayload),
    store: new FakeJobStore(),
    now: () => new Date("2026-06-17T12:00:00.000Z"),
    services: {
      barStore: fakeBarStore(),
      paperStore: fakePaperStore(),
    },
  });
  assert("paper monitor succeeds as paper-only no-op with no open positions", paperMonitorResult.success);
  if (paperMonitorResult.success) {
    eq("paper monitor no-op result", paperMonitorResult.result, {
      paperOnly: true,
      evaluatedAt: "2026-06-17T12:00:00.000Z",
      openPositions: 0,
      matchedPositions: 0,
      updatedPositions: 0,
      closedPositions: 0,
      skippedPositions: 0,
      groups: [],
    });
  }
  eq("telegram refresh is deferred non-retryably", await handleTelegramRefresh(telegramPayload, {} as never), {
    success: false,
    retryable: false,
    error: "handler_not_implemented",
    result: {
      jobType: "telegram.refresh",
      reason:
        "telegram.refresh is registered but deferred until a safe snapshot-only refresh path exists; P8C does not send Telegram messages",
    },
  });
}

async function runWorkerChecks(): Promise<void> {
  console.log("\n=== worker once behavior ===");
  const noJobStore = new FakeJobStore();
  const noJob = await runJobWorkerOnce({
    store: noJobStore,
    workerId: "smoke",
    leaseMs: 30,
  });
  eq("worker once exits cleanly with no job", noJob.status, "no_job");
  eq("worker recovers before claim", noJobStore.recoverCalls, 1);

  const successPayload: Extract<JobPayload, { jobType: "dashboard.snapshot" }> = {
    jobType: "dashboard.snapshot",
    snapshotType: "dashboard",
  };
  const successStore = new FakeJobStore([job(successPayload, 10)]);
  let handlerRan = false;
  const successHandler: JobHandler = async () => {
    handlerRan = true;
    await sleep(45);
    return { success: true, result: { ok: true } };
  };
  const success = await runJobWorkerOnce({
    store: successStore,
    workerId: "smoke",
    leaseMs: 30,
    handlers: { "dashboard.snapshot": successHandler },
  });
  eq("worker claims and completes one job", success.status, "succeeded");
  eq("worker ran handler", handlerRan, true);
  assert("heartbeat starts during work", successStore.heartbeatCalls > 0);
  const heartbeatsAfterSuccess = successStore.heartbeatCalls;
  await sleep(35);
  eq("heartbeat stops after success", successStore.heartbeatCalls, heartbeatsAfterSuccess);
  assert(
    "worker appends handler lifecycle events",
    successStore.events.some((event) => event.eventType === "handler_started") &&
      successStore.events.some((event) => event.eventType === "handler_finished"),
  );

  const retryPayload: Extract<JobPayload, { jobType: "dashboard.snapshot" }> = {
    jobType: "dashboard.snapshot",
    snapshotType: "dashboard",
  };
  const retryStore = new FakeJobStore([job(retryPayload, 11)]);
  const retry = await runJobWorkerOnce({
    store: retryStore,
    workerId: "smoke",
    leaseMs: 30,
    handlers: {
      "dashboard.snapshot": async () => {
        await sleep(45);
        return { success: false, retryable: true, error: "temporary_provider_error" };
      },
    },
  });
  eq("worker fails retryable errors with retry policy", retry.status, "requeued");
  eq("retryable failure policy preserved", retryStore.retryPolicies.at(-1)?.retryable, true);
  const heartbeatsAfterFailure = retryStore.heartbeatCalls;
  await sleep(35);
  eq("heartbeat stops after failure", retryStore.heartbeatCalls, heartbeatsAfterFailure);

  const invalidPayload = { jobType: "unknown.job" } as unknown as JobPayload;
  const invalidStore = new FakeJobStore([job(invalidPayload, 12)]);
  const invalid = await runJobWorkerOnce({
    store: invalidStore,
    workerId: "smoke",
    leaseMs: 30,
  });
  eq("worker fails invalid payloads non-retryably", invalid.status, "failed");
  eq("invalid payload retry policy is false", invalidStore.retryPolicies.at(-1)?.retryable, false);
}

function listFiles(dir: string): string[] {
  const abs = path.join(process.cwd(), dir);
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  });
}

function runStaticChecks(): void {
  console.log("\n=== static worker boundary checks ===");
  const files = [
    ...listFiles("lib/jobs/handlers").filter((file) => file.endsWith(".ts")),
    "lib/jobs/worker.ts",
    "scripts/runJobWorker.ts",
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert(`${file} has no NextRequest import`, !text.includes("NextRequest"));
    assert(`${file} has no NextResponse import`, !text.includes("NextResponse"));
    assert(`${file} does not import route files`, !text.includes("app/api"));
    assert(`${file} does not fetch API routes`, !text.includes("fetch('/api") && !text.includes('fetch("/api'));
  }
  assert("no live execution job types introduced", JOB_TYPES.every((jobType) => !FORBIDDEN_LIVE_JOB_TYPES.includes(jobType as never)));
}

async function main(): Promise<void> {
  await runRegistryChecks();
  await runHandlerChecks();
  await runWorkerChecks();
  await runStrategiesRiskGateChecks();
  runStaticChecks();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
