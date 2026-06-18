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
