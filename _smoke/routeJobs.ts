import fs from "node:fs";
import path from "node:path";
import type { JobRecord, JobStatus, JobStore, ListJobsFilter } from "@/lib/jobs/jobStore";
import type { JobPayload } from "@/lib/jobs/types";
import { FORBIDDEN_LIVE_JOB_TYPES, JOB_TYPES, validateJobPayload } from "@/lib/jobs/types";
import {
  buildDashboardRefreshJob,
  buildRefreshJobRequest,
  buildRegimeRefreshJob,
  buildTelegramRefreshJob,
  dedupeKeyForJob,
  enqueueJobForRoute,
} from "@/lib/jobs/routeHelpers";
import {
  PRESENTED_JOB_STATUSES,
  isPresentedJobStatus,
  presentJob,
} from "@/lib/jobs/jobStatusPresenter";
import {
  emptyDashboardSignals,
  readDashboardSignals,
  type DashboardSnapshotReader,
} from "@/lib/jobs/dashboardSignalsReader";
import type { DashboardSnapshotFilter, DashboardSnapshotRecord } from "@/lib/jobs/dashboardSnapshotStore";
import {
  isRefreshBusy,
  refreshStateFromJobStatus,
} from "@/components/dashboard/RefreshButton";
import {
  normalizeRegimeRouteSymbol,
  readRegimeRouteState,
} from "@/lib/regime/regimeRouteReader";
import type { RegimeSnapshotRow } from "@/lib/storage/interfaces";

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

function fakeJob(input: {
  id?: number;
  publicId?: string;
  payload?: JobPayload;
  status?: JobStatus;
  dedupeKey?: string | null;
  result?: unknown;
} = {}): JobRecord {
  const payload = input.payload ?? {
    jobType: "dashboard.snapshot",
    snapshotType: "dashboard",
  };
  return {
    id: input.id ?? 42,
    publicId: input.publicId ?? "job_public_42",
    jobType: payload.jobType,
    status: input.status ?? "queued",
    priority: 100,
    payload,
    result: input.result ?? null,
    dedupeKey: input.dedupeKey ?? null,
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

class FakeJobStore implements Pick<JobStore, "enqueueJob" | "listJobs"> {
  jobs: JobRecord[] = [];
  enqueueCalls = 0;

  constructor(seed: JobRecord[] = []) {
    this.jobs = [...seed];
  }

  async enqueueJob(payload: JobPayload, options: { dedupeKey?: string } = {}): Promise<JobRecord> {
    this.enqueueCalls++;
    const job = fakeJob({
      id: this.jobs.length + 1,
      publicId: `job_public_${this.jobs.length + 1}`,
      payload,
      dedupeKey: options.dedupeKey ?? null,
    });
    this.jobs.unshift(job);
    return job;
  }

  async listJobs(filter: ListJobsFilter = {}): Promise<JobRecord[]> {
    return this.jobs
      .filter((job) => !filter.jobType || job.jobType === filter.jobType)
      .filter((job) => {
        if (!filter.status) return true;
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        return statuses.includes(job.status);
      })
      .slice(0, filter.limit ?? 50);
  }
}

function snapshot(payload: unknown, generatedAt = "2026-06-17T10:00:00.000Z"): DashboardSnapshotRecord {
  return {
    id: 7,
    publicId: "snap_public_7",
    snapshotType: "dashboard",
    symbol: null,
    timeframe: null,
    payload,
    sourceJobId: 42,
    generatedAt,
    expiresAt: null,
    createdAt: generatedAt,
  };
}

function regimeSnapshotRow(symbol = "BTC-USD"): RegimeSnapshotRow {
  return {
    symbol,
    exchange: "COINBASE",
    ts: "2026-06-17T11:00:00.000Z",
    regime: "TREND_UP",
    reliability: 0.91,
    directionalBias: "UP",
    tradePermission: "ALLOW_UP_ONLY",
    edgeMultiplier: 0.9,
    sizeMultiplier: 1.25,
    reason: "persisted regime row",
    rawResponse: {
      signal: {
        emaContext: { ema20Slope: "up", ema50Above200: true },
        volContext: { atrPct: 1.2, atrRegime: "normal", relVol: 1.1 },
      },
    },
    regimeModelVersion: "a6.test",
    promptVersion: "prompt.test",
    featureVersion: "features.test",
  };
}

async function runPayloadBuilderChecks(): Promise<void> {
  console.log("\n=== refresh payload builders ===");
  const requests = [
    { type: "dashboard" },
    { type: "regime", symbols: ["BTC"], exchange: "COINBASE", timeframe: "1h" },
    { type: "market", symbols: ["BTC-USD"], exchange: "COINBASE", timeframe: "1h", source: "coinbase" },
    { type: "features", symbols: ["BTC-USD"], exchange: "COINBASE", timeframe: "1h" },
    { type: "strategies", symbols: ["BTC-USD"], exchange: "COINBASE", timeframe: "1h", strategyIds: ["momentum_continuation"] },
  ];
  for (const request of requests) {
    const built = buildRefreshJobRequest(request);
    assert(`builder accepts ${request.type}`, !("error" in built), built);
    if (!("error" in built)) {
      eq(`payload validates ${request.type}`, validateJobPayload(built.payload).jobType, built.payload.jobType);
    }
  }

  const dashboard = buildDashboardRefreshJob();
  eq("dashboard refresh helper builds dashboard.snapshot", dashboard.payload, {
    jobType: "dashboard.snapshot",
    snapshotType: "dashboard",
  });
  eq("dashboard refresh dedupe key", dashboard.dedupeKey, "dashboard.snapshot:dashboard");

  const regime = buildRegimeRefreshJob({ symbol: "btc" });
  eq("regime refresh helper builds regime.compute", regime.payload.jobType, "regime.compute");
  eq("regime refresh normalizes symbol", regime.payload.jobType === "regime.compute" ? regime.payload.symbols : [], ["BTC-USD"]);
  eq("regime refresh dedupe key", regime.dedupeKey, "regime.compute:COINBASE:1h:BTC-USD");

  const regimeAgain = buildRegimeRefreshJob({ symbol: "BTC-USD" });
  eq("dedupe key generation is stable", regimeAgain.dedupeKey, regime.dedupeKey);

  const strategies = buildRefreshJobRequest({
    type: "strategies",
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
    strategyIds: ["momentum_continuation"],
  });
  assert("strategy ids keep caller casing", !("error" in strategies) && strategies.payload.jobType === "strategies.evaluate" && strategies.payload.strategyIds?.[0] === "momentum_continuation");
}

async function runEnqueueChecks(): Promise<void> {
  console.log("\n=== route enqueue helpers ===");
  const dashboard = buildDashboardRefreshJob();
  const dashboardStore = new FakeJobStore();
  const queuedDashboard = await enqueueJobForRoute(dashboardStore, dashboard.payload, {
    dedupeKey: dashboard.dedupeKey,
  });
  eq("dashboard default helper enqueues dashboard.snapshot", queuedDashboard.job.jobType, "dashboard.snapshot");
  eq("dashboard default helper does not fake dedupe", queuedDashboard.deduped, false);

  const existing = fakeJob({
    payload: dashboard.payload,
    dedupeKey: dashboard.dedupeKey,
    publicId: "job_existing_dashboard",
  });
  const dedupeStore = new FakeJobStore([existing]);
  const deduped = await enqueueJobForRoute(dedupeStore, dashboard.payload, {
    dedupeKey: dashboard.dedupeKey,
  });
  eq("active dedupe returns existing public id", deduped.job.publicId, "job_existing_dashboard");
  eq("active dedupe flag set", deduped.deduped, true);
  eq("active dedupe avoids enqueue", dedupeStore.enqueueCalls, 0);

  const regime = buildRegimeRefreshJob({ symbol: "BTC" });
  const regimeStore = new FakeJobStore();
  const queuedRegime = await enqueueJobForRoute(regimeStore, regime.payload, {
    dedupeKey: regime.dedupeKey,
  });
  eq("regime default helper enqueues regime.compute", queuedRegime.job.jobType, "regime.compute");
}

function runPresenterChecks(): void {
  console.log("\n=== job status presenter ===");
  const job = fakeJob({ id: 123, publicId: "job_public_presented" });
  const presented = presentJob(job);
  eq("presenter returns public id", presented.id, "job_public_presented");
  assert("presenter does not expose internal id", !("publicId" in presented) && presented.id !== String(job.id), presented);
  for (const status of ["queued", "running", "succeeded", "failed", "dead", "cancelled"]) {
    assert(`presenter accepts ${status}`, isPresentedJobStatus(status));
  }
  eq("presenter status set matches contract", PRESENTED_JOB_STATUSES, [
    "queued",
    "running",
    "succeeded",
    "failed",
    "dead",
    "cancelled",
  ]);
}

async function runSignalsReaderChecks(): Promise<void> {
  console.log("\n=== dashboard snapshot selection ===");
  let capturedFilter: DashboardSnapshotFilter | null = null;
  const reader: DashboardSnapshotReader = {
    async fetchLatestSnapshot(filter) {
      capturedFilter = filter;
      return snapshot({ generatedAt: "snapshot", agentResults: [], stats: null, activity: [] });
    },
  };
  const snapshotResult = await readDashboardSignals({
    snapshotStore: reader,
    memoryResponse: { generatedAt: "memory" },
    memoryExpiresAt: Date.now() + 60_000,
  });
  eq("signals reader prefers dashboard_snapshots", snapshotResult.source, "dashboard_snapshots");
  eq("signals reader requests non-expired dashboard snapshot", capturedFilter, {
    snapshotType: "dashboard",
    includeExpired: false,
  });

  const memoryResult = await readDashboardSignals({
    memoryResponse: { generatedAt: "memory" },
    memoryExpiresAt: Date.now() + 60_000,
  });
  eq("signals reader falls back to memCache", memoryResult, {
    source: "memCache",
    payload: { generatedAt: "memory" },
  });

  const emptyResult = await readDashboardSignals({
    memoryResponse: { generatedAt: "expired" },
    memoryExpiresAt: Date.now() - 1,
  });
  eq("signals reader falls back to empty state", emptyResult, {
    source: "empty",
    payload: emptyDashboardSignals(),
  });
}

async function runRegimeRouteReaderChecks(): Promise<void> {
  console.log("\n=== regime route persisted reads ===");
  const lookup = normalizeRegimeRouteSymbol("btc");
  eq("regime route normalizes persisted symbol", lookup.persistedSymbol, "BTC-USD");
  assert("regime route can match dashboard BTC key", lookup.dashboardCandidates.includes("BTC"));

  const persisted = await readRegimeRouteState({
    symbol: "btc",
    regimeStore: {
      async latest(filter) {
        return filter.symbol === "BTC-USD" ? regimeSnapshotRow(filter.symbol) : null;
      },
    },
    dashboardSnapshotStore: {
      async fetchLatestSnapshot() {
        return snapshot({
          generatedAt: "2026-06-17T10:00:00.000Z",
          regimeMap: {
            BTC: {
              regime: "CHOP",
              reliability: 0.8,
              emaContext: null,
              volContext: null,
            },
          },
        });
      },
    },
    memoryResponse: {
      generatedAt: "2026-06-17T09:00:00.000Z",
      regimeMap: {
        BTC: {
          regime: "LOW_VOL",
          reliability: 0.7,
          emaContext: null,
          volContext: null,
        },
      },
    },
  });
  eq("regime route prefers regime_snapshots", persisted.source, "regime_snapshots");
  assert("regime route persisted body succeeds", persisted.body.success);
  if (persisted.body.success) {
    eq("regime route persisted symbol response", persisted.body.symbol, "BTC");
    eq("regime route persisted trade permission", persisted.body.tradePermission, "ALLOW_UP_ONLY");
    eq("regime route persisted updatedAt", persisted.body.updatedAt, "2026-06-17T11:00:00.000Z");
  }

  const snapshotFallback = await readRegimeRouteState({
    symbol: "BTC-USD",
    regimeStore: {
      async latest() {
        return null;
      },
    },
    dashboardSnapshotStore: {
      async fetchLatestSnapshot(filter) {
        eq("regime route dashboard fallback requests non-expired snapshot", filter, {
          snapshotType: "dashboard",
          includeExpired: false,
        });
        return snapshot({
          generatedAt: "2026-06-17T10:00:00.000Z",
          regimeMap: {
            BTC: {
              regime: "CHOP",
              reliability: 0.8,
              emaContext: { ema20Slope: "flat" },
              volContext: { atrRegime: "low" },
            },
          },
        });
      },
    },
  });
  eq("regime route falls back to dashboard_snapshots", snapshotFallback.source, "dashboard_snapshots");
  assert("regime route dashboard fallback body succeeds", snapshotFallback.body.success);
  if (snapshotFallback.body.success) {
    eq("regime route dashboard fallback maps permission", snapshotFallback.body.tradePermission, "BLOCK_OR_EXCEPTIONAL_ONLY");
    eq("regime route dashboard fallback updatedAt", snapshotFallback.body.updatedAt, "2026-06-17T10:00:00.000Z");
  }

  const memoryFallback = await readRegimeRouteState({
    symbol: "BTC",
    memoryResponse: {
      generatedAt: "2026-06-17T09:00:00.000Z",
      regimeMap: {
        BTC: {
          regime: "LOW_VOL",
          reliability: 0.7,
          emaContext: null,
          volContext: null,
        },
      },
    },
  });
  eq("regime route falls back to memCache", memoryFallback.source, "memCache");

  const empty = await readRegimeRouteState({ symbol: "DOGE" });
  eq("regime route empty state is 404", empty.status, 404);
  eq("regime route empty state source", empty.source, "empty");
}

function runRefreshButtonChecks(): void {
  console.log("\n=== refresh button state helpers ===");
  eq("queued job maps to queued state", refreshStateFromJobStatus("queued"), "queued");
  eq("running job maps to running state", refreshStateFromJobStatus("running"), "running");
  eq("succeeded job maps to success state", refreshStateFromJobStatus("succeeded"), "success");
  eq("failed job maps to error state", refreshStateFromJobStatus("failed"), "error");
  eq("dead job maps to error state", refreshStateFromJobStatus("dead"), "error");
  eq("cancelled job maps to error state", refreshStateFromJobStatus("cancelled"), "error");
  assert("busy helper blocks duplicate queued clicks", isRefreshBusy("queueing") && isRefreshBusy("queued") && isRefreshBusy("running"));
  assert("busy helper allows idle clicks", !isRefreshBusy("idle"));
}

async function runTelegramRefreshChecks(): Promise<void> {
  console.log("\n=== telegram refresh queue helper ===");
  const built = buildTelegramRefreshJob({ symbol: "btc" });
  eq("telegram refresh queues dashboard snapshot", built.payload.jobType, "dashboard.snapshot");
  eq("telegram refresh includes normalized symbol", built.payload.jobType === "dashboard.snapshot" ? built.payload.symbols : [], ["BTC-USD"]);
  const store = new FakeJobStore();
  const queued = await enqueueJobForRoute(store, built.payload, { dedupeKey: built.dedupeKey });
  eq("telegram refresh helper enqueues via job store", queued.job.jobType, "dashboard.snapshot");
}

function readText(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

function assertNoRouteBoundaryLeaks(file: string): void {
  const text = readText(file);
  assert(`${file} does not import worker handlers`, !text.includes("/handlers") && !text.includes("\\handlers"));
  assert(`${file} does not import lib/jobs/worker`, !text.includes("lib/jobs/worker"));
  assert(`${file} does not call dashboard refresh route`, !text.includes("/api/cache/refresh"));
  assert(`${file} does not call regime refresh route`, !text.includes("/api/regime/refresh"));
}

function runStaticChecks(): void {
  console.log("\n=== static route boundaries ===");
  for (const file of [
    "app/api/cache/refresh/route.ts",
    "app/api/regime/[symbol]/route.ts",
    "app/api/regime/refresh/route.ts",
    "app/api/jobs/refresh/route.ts",
    "app/api/jobs/[id]/route.ts",
    "app/api/jobs/status/route.ts",
    "app/api/telegram/webhook/route.ts",
  ]) {
    assertNoRouteBoundaryLeaks(file);
  }

  for (const file of [
    "lib/jobs/scheduler.ts",
    "scripts/jobScheduler.ts",
    "app/api/jobs/worker/route.ts",
    "app/api/jobs/scheduler/route.ts",
    "app/api/cron/route.ts",
  ]) {
    assert(`no scheduler/cron/live execution file added: ${file}`, !fs.existsSync(path.join(process.cwd(), file)));
  }
  assert("no live execution job types introduced", JOB_TYPES.every((jobType) => !FORBIDDEN_LIVE_JOB_TYPES.includes(jobType as never)));
}

async function main(): Promise<void> {
  await runPayloadBuilderChecks();
  await runEnqueueChecks();
  runPresenterChecks();
  await runSignalsReaderChecks();
  await runRegimeRouteReaderChecks();
  runRefreshButtonChecks();
  await runTelegramRefreshChecks();
  runStaticChecks();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
