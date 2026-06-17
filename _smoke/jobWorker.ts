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
import { handleTelegramRefresh } from "@/lib/jobs/handlers/telegramRefresh";
import type { Bar } from "@/lib/quant/types";

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
          symbols: {
            "BTC-USD": {
              fetchedBars: 1,
              insertedBars: 1,
              skippedBars: 0,
              latestTs: "2026-06-17T11:00:00.000Z",
            },
          },
        };
      },
    },
  });
  assert("market handler succeeds", marketResult.success);
  eq("market handler calls ingest service", marketCalled, true);

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
      async runDashboardRefreshPipeline() {
        dashboardRefreshCalled = true;
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
  eq("paper monitor is deferred non-retryably", await handlePaperMonitor(paperPayload, {} as never), {
    success: false,
    retryable: false,
    error: "handler_not_implemented",
    result: {
      jobType: "paper.monitor",
      reason:
        "paper.monitor needs a closed-bar payload or persisted bar selection policy before worker execution can safely update paper positions",
    },
  });
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
  runStaticChecks();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
