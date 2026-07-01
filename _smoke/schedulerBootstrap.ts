import fs from "node:fs";
import path from "node:path";
import {
  authorizeSchedulerRequest,
  buildScheduledFeedPlan,
  enqueueScheduledFeed,
  floorToClosedBar,
} from "@/lib/jobs/scheduler";
import type {
  EnqueueJobOptions,
  JobRecord,
  JobStatus,
  JobStore,
  ListJobsFilter,
} from "@/lib/jobs/jobStore";
import { FORBIDDEN_LIVE_JOB_TYPES, JOB_TYPES, type JobPayload, validateJobPayload } from "@/lib/jobs/types";
import { handlePaperMonitor } from "@/lib/jobs/handlers/paperMonitor";
import type { JobHandlerServices } from "@/lib/jobs/handlers";

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

function fakeJob(
  payload: JobPayload,
  id: number,
  options: EnqueueJobOptions = {},
  status: JobStatus = "queued",
): JobRecord {
  const runAfter = options.runAfter instanceof Date
    ? options.runAfter.toISOString()
    : typeof options.runAfter === "string"
      ? new Date(options.runAfter).toISOString()
      : "2026-06-18T14:00:00.000Z";
  return {
    id,
    publicId: `job_public_${id}`,
    jobType: payload.jobType,
    status,
    priority: options.priority ?? 100,
    payload,
    result: null,
    dedupeKey: options.dedupeKey ?? null,
    runAfter,
    attempts: 0,
    maxAttempts: options.maxAttempts ?? 3,
    lockedBy: null,
    lockedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    error: null,
    createdAt: "2026-06-18T15:05:00.000Z",
    updatedAt: "2026-06-18T15:05:00.000Z",
  };
}

class FakeSchedulerStore implements Pick<JobStore, "enqueueJob" | "listJobs"> {
  jobs: JobRecord[] = [];
  enqueueCalls = 0;

  async enqueueJob(payload: JobPayload, options: EnqueueJobOptions = {}): Promise<JobRecord> {
    this.enqueueCalls++;
    const job = fakeJob(payload, this.jobs.length + 1, options);
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

function readText(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

function assertNoText(file: string, patterns: string[]): void {
  const text = readText(file);
  for (const pattern of patterns) {
    assert(`${file} does not contain ${pattern}`, !text.includes(pattern));
  }
}

async function runClosedBarChecks(): Promise<void> {
  console.log("\n=== closed bar logic ===");
  eq(
    "closed bar example matches P8E contract",
    floorToClosedBar(new Date("2026-06-18T15:05:00.000Z"), "1h"),
    "2026-06-18T14:00:00.000Z",
  );
  eq(
    "scheduler never selects current open bar at exact hour",
    floorToClosedBar(new Date("2026-06-18T15:00:00.000Z"), "1h"),
    "2026-06-18T14:00:00.000Z",
  );
  eq(
    "closed bar math uses UTC across day boundary",
    floorToClosedBar(new Date("2026-06-18T00:05:00.000Z"), "1h"),
    "2026-06-17T23:00:00.000Z",
  );
  eq(
    "daily closed bar example (P10C) selects the prior UTC day",
    floorToClosedBar(new Date("2026-06-18T15:05:00.000Z"), "1d"),
    "2026-06-17T00:00:00.000Z",
  );
  eq(
    "daily closed bar never selects the still-open current day at exact midnight",
    floorToClosedBar(new Date("2026-06-18T00:00:00.000Z"), "1d"),
    "2026-06-17T00:00:00.000Z",
  );
}

const DAILY_CONTEXT_STAGE_NAMES = new Set(["daily.market.ingest.latest", "daily.features.compute"]);

async function runPlanChecks(): Promise<void> {
  console.log("\n=== scheduled feed plan ===");
  const plan = buildScheduledFeedPlan({
    now: new Date("2026-06-18T15:05:00.000Z"),
    env: {} as NodeJS.ProcessEnv,
  });

  eq("scheduled feed name is exact", plan.feedName, "non-stop scheduled feed");
  eq("scheduled feed builds all eight stages", plan.stages.map((stage) => stage.stage), [
    "daily.market.ingest.latest",
    "daily.features.compute",
    "market.ingest.latest",
    "features.compute",
    "regime.compute",
    "strategies.evaluate",
    "paper.monitor",
    "dashboard.snapshot",
  ]);
  eq("scheduled feed uses default symbols", plan.symbols, [
    "BTC-USD",
    "ETH-USD",
    "SOL-USD",
    "LINK-USD",
    "AVAX-USD",
  ]);
  eq(
    "daily closed bar (P10C) is the prior UTC day, independent of the hourly closed bar",
    plan.dailyClosedBarTs,
    "2026-06-17T00:00:00.000Z",
  );
  eq("hourly closed bar is unchanged by the daily context addition", plan.closedBarTs, "2026-06-18T14:00:00.000Z");

  for (const stage of plan.stages) {
    eq(`payload validates for ${stage.stage}`, validateJobPayload(stage.payload).jobType, stage.payload.jobType);
    const expectedSuffix = DAILY_CONTEXT_STAGE_NAMES.has(stage.stage) ? plan.dailyClosedBarTs : plan.closedBarTs;
    assert(`dedupe key for ${stage.stage} includes the correct closed bar`, stage.dedupeKey.includes(expectedSuffix));
  }
  eq(
    "daily context payloads request timeframe=1d",
    plan.stages
      .filter((stage) => DAILY_CONTEXT_STAGE_NAMES.has(stage.stage))
      .map((stage) => (stage.payload as { timeframe?: string }).timeframe),
    ["1d", "1d"],
  );
  eq(
    "daily context stages never touch regime/strategy/paper/execution job types",
    plan.stages
      .filter((stage) => DAILY_CONTEXT_STAGE_NAMES.has(stage.stage))
      .map((stage) => stage.jobType),
    ["market.ingest.latest", "features.compute"],
  );

  eq("priorities are staged", plan.stages.map((stage) => stage.priority), [5, 7, 10, 20, 30, 40, 50, 60]);
  eq("runAfter offsets are staged from the correct closed bar timestamp", plan.stages.map((stage) => stage.runAfter), [
    "2026-06-17T00:01:00.000Z",
    "2026-06-17T00:03:00.000Z",
    "2026-06-18T14:05:00.000Z",
    "2026-06-18T14:07:00.000Z",
    "2026-06-18T14:09:00.000Z",
    "2026-06-18T14:11:00.000Z",
    "2026-06-18T14:13:00.000Z",
    "2026-06-18T14:15:00.000Z",
  ]);
  eq("dashboard final stage is dashboard snapshot", plan.stages.at(-1)?.payload, {
    jobType: "dashboard.snapshot",
    snapshotType: "dashboard",
  });
}

async function runEnqueueChecks(): Promise<void> {
  console.log("\n=== scheduled feed enqueue ===");
  const store = new FakeSchedulerStore();
  const first = await enqueueScheduledFeed({
    store,
    now: new Date("2026-06-18T15:05:00.000Z"),
    env: {} as NodeJS.ProcessEnv,
  });
  eq("first scheduler run enqueues eight jobs (P10C: incl. daily context)", first.jobs.map((job) => job.action), [
    "enqueued",
    "enqueued",
    "enqueued",
    "enqueued",
    "enqueued",
    "enqueued",
    "enqueued",
    "enqueued",
  ]);
  eq("first scheduler run makes eight enqueue calls", store.enqueueCalls, 8);

  const second = await enqueueScheduledFeed({
    store,
    now: new Date("2026-06-18T15:05:00.000Z"),
    env: {} as NodeJS.ProcessEnv,
  });
  eq("repeated scheduler run dedupes active jobs", second.jobs.map((job) => job.action), [
    "deduped",
    "deduped",
    "deduped",
    "deduped",
    "deduped",
    "deduped",
    "deduped",
    "deduped",
  ]);
  eq("repeated scheduler run avoids new enqueue calls", store.enqueueCalls, 8);

  for (const job of store.jobs) job.status = "succeeded";
  const third = await enqueueScheduledFeed({
    store,
    now: new Date("2026-06-18T15:05:00.000Z"),
    env: {} as NodeJS.ProcessEnv,
  });
  eq("terminal succeeded scheduled jobs are skipped", third.jobs.map((job) => job.action), [
    "skipped_succeeded",
    "skipped_succeeded",
    "skipped_succeeded",
    "skipped_succeeded",
    "skipped_succeeded",
    "skipped_succeeded",
    "skipped_succeeded",
    "skipped_succeeded",
  ]);

  // P10C: daily context stages dedupe against the closed DAILY bar
  // specifically, independent of the hourly closed bar. Hold closedBarTs
  // fixed (so the six hourly stages stay skip_succeeded) while advancing
  // dailyClosedBarTs a few hours later the same UTC day — daily stages must
  // still skip_succeeded, since the daily bar itself hasn't rolled over.
  const sameDayLater = await enqueueScheduledFeed({
    store,
    now: new Date("2026-06-18T18:05:00.000Z"),
    closedBarTs: "2026-06-18T14:00:00.000Z",
    dailyClosedBarTs: "2026-06-17T00:00:00.000Z",
    env: {} as NodeJS.ProcessEnv,
  });
  const dailyStages = sameDayLater.jobs.filter((job) => job.stage.startsWith("daily."));
  eq(
    "daily context stages stay skipped_succeeded within the same UTC day",
    dailyStages.map((job) => job.action),
    ["skipped_succeeded", "skipped_succeeded"],
  );
  eq(
    "hourly stages also stay skipped_succeeded when the hourly closed bar is unchanged",
    sameDayLater.jobs.filter((job) => !job.stage.startsWith("daily.")).map((job) => job.action),
    ["skipped_succeeded", "skipped_succeeded", "skipped_succeeded", "skipped_succeeded", "skipped_succeeded", "skipped_succeeded"],
  );
  eq("same-day rerun makes no new enqueue calls", store.enqueueCalls, 8);

  // Now roll ONLY the daily closed bar forward (simulating the next UTC day)
  // while keeping the hourly closed bar the same, to isolate daily-only
  // rollover behavior from the hourly rollover that happens every run.
  const nextDay = await enqueueScheduledFeed({
    store,
    now: new Date("2026-06-19T14:05:00.000Z"),
    closedBarTs: "2026-06-18T14:00:00.000Z",
    dailyClosedBarTs: "2026-06-18T00:00:00.000Z",
    env: {} as NodeJS.ProcessEnv,
  });
  const nextDayDailyStages = nextDay.jobs.filter((job) => job.stage.startsWith("daily."));
  eq(
    "daily context stages enqueue fresh work once the daily bar rolls over",
    nextDayDailyStages.map((job) => job.action),
    ["enqueued", "enqueued"],
  );
  eq(
    "hourly stages remain skipped_succeeded while only the daily bar rolled over",
    nextDay.jobs.filter((job) => !job.stage.startsWith("daily.")).map((job) => job.action),
    ["skipped_succeeded", "skipped_succeeded", "skipped_succeeded", "skipped_succeeded", "skipped_succeeded", "skipped_succeeded"],
  );
  eq("daily rollover run makes exactly two new enqueue calls", store.enqueueCalls, 10);

  const dryRun = await enqueueScheduledFeed({
    dryRun: true,
    now: new Date("2026-06-18T15:05:00.000Z"),
    env: {} as NodeJS.ProcessEnv,
  });
  eq("dry-run plans eight jobs without a store", dryRun.jobs.map((job) => job.action), [
    "dry_run",
    "dry_run",
    "dry_run",
    "dry_run",
    "dry_run",
    "dry_run",
    "dry_run",
    "dry_run",
  ]);

  const usdtStore = new FakeSchedulerStore();
  let usdtError: string | null = null;
  try {
    await enqueueScheduledFeed({
      store: usdtStore,
      now: new Date("2026-06-18T15:05:00.000Z"),
      env: { SCHEDULED_FEED_SYMBOLS: "BTC/USDT" } as unknown as NodeJS.ProcessEnv,
    });
  } catch (err) {
    usdtError = err instanceof Error ? err.message : String(err);
  }
  assert(
    "scheduled feed SCHEDULED_FEED_SYMBOLS=BTC/USDT is rejected",
    usdtError !== null && usdtError.includes("not the canonical scheduled market"),
    usdtError,
  );
  eq("scheduled feed BTC/USDT makes no enqueue calls", usdtStore.enqueueCalls, 0);
  assert(
    "scheduled feed BTC/USDT does not silently enqueue BTC-USD",
    usdtStore.jobs.every((job) => !("symbols" in job.payload) || !job.payload.symbols?.includes("BTC-USD")),
    usdtStore.jobs,
  );
}

function runAuthChecks(): void {
  console.log("\n=== scheduler route auth ===");
  const denied = authorizeSchedulerRequest({
    headers: new Headers(),
    searchParams: new URLSearchParams(),
    env: { SCHEDULER_SECRET: "secret" } as unknown as NodeJS.ProcessEnv,
    nodeEnv: "production",
  });
  eq("secret-configured scheduler rejects unauthorized requests", denied.authorized, false);

  const secretHeaders = new Headers({ authorization: "Bearer secret" });
  const allowed = authorizeSchedulerRequest({
    headers: secretHeaders,
    searchParams: new URLSearchParams(),
    env: { SCHEDULER_SECRET: "secret" } as unknown as NodeJS.ProcessEnv,
    nodeEnv: "production",
  });
  eq("secret-configured scheduler accepts bearer token", allowed.authorized, true);

  const cronAllowed = authorizeSchedulerRequest({
    headers: new Headers({ "user-agent": "vercel-cron/1.0" }),
    searchParams: new URLSearchParams(),
    env: {} as NodeJS.ProcessEnv,
    nodeEnv: "production",
  });
  eq("scheduler allows Vercel Cron user-agent when no secret is configured", cronAllowed.authorized, true);

  const localDryRun = authorizeSchedulerRequest({
    headers: new Headers(),
    searchParams: new URLSearchParams("dryRun=1"),
    env: { SCHEDULER_SECRET: "secret" } as unknown as NodeJS.ProcessEnv,
    nodeEnv: "development",
  });
  eq("local dry-run is explicitly allowed", localDryRun.authorized, true);
}

async function runPaperMonitorChecks(): Promise<void> {
  console.log("\n=== paper monitor implementation ===");
  const payload: Extract<JobPayload, { jobType: "paper.monitor" }> = {
    jobType: "paper.monitor",
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
  };
  const services = {
    paperStore: {
      async listPositions() {
        return [];
      },
    },
    barStore: {
      async insert() {
        throw new Error("not needed");
      },
      async insertMany() {
        throw new Error("not needed");
      },
      async fetchRange() {
        return [];
      },
      async fetchRecent() {
        return [];
      },
      async latestTs() {
        return null;
      },
    },
  } as unknown as JobHandlerServices;
  const result = await handlePaperMonitor(payload, {
    workerId: "smoke",
    job: fakeJob(payload, 77),
    store: {} as JobStore,
    now: () => new Date("2026-06-18T15:05:00.000Z"),
    services,
  });
  assert("paper.monitor is implemented as a safe paper-only no-op when no positions match", result.success);
  if (result.success) {
    assert("paper.monitor result is paper-only", Boolean((result.result as { paperOnly?: unknown }).paperOnly));
  }

  assertNoText("lib/jobs/handlers/paperMonitor.ts", [
    "handler_not_implemented",
    "broker.submit",
    "exchange.order",
    "live.execute",
  ]);
}

function runStaticChecks(): void {
  console.log("\n=== static scheduler boundaries ===");
  for (const file of [
    "lib/jobs/scheduler/types.ts",
    "lib/jobs/scheduler/closedBar.ts",
    "lib/jobs/scheduler/scheduledFeed.ts",
    "lib/jobs/scheduler/index.ts",
    "scripts/enqueueScheduledFeed.ts",
  ]) {
    assertNoText(file, [
      "lib/jobs/worker",
      "/handlers",
      "\\handlers",
      "/api/cache/refresh",
      "/api/regime/refresh",
      "fetch('/api",
      "fetch(\"/api",
    ]);
  }

  assertNoText("app/api/jobs/schedule/route.ts", [
    "lib/jobs/worker",
    "/handlers",
    "\\handlers",
    "/api/cache/refresh",
    "/api/regime/refresh",
    "fetch('/api",
    "fetch(\"/api",
  ]);
  const vercelConfig = JSON.parse(readText("vercel.json")) as { crons?: unknown[] };
  assert("vercel.json does not register Vercel Cron", !vercelConfig.crons || vercelConfig.crons.length === 0);
  assert("protected scheduler route remains present", fs.existsSync(path.join(process.cwd(), "app/api/jobs/schedule/route.ts")));

  const linuxRunbook = readText("docs/P8_LINUX_SCHEDULER.md");
  assert("Linux runbook documents the scheduler route", linuxRunbook.includes("/api/jobs/schedule"));
  assert("Linux runbook documents minute-five systemd cadence", linuxRunbook.includes("*:05:00"));
  assert("Linux runbook documents scheduler secret handling", linuxRunbook.includes("SCHEDULER_SECRET"));
  assert("Linux runbook keeps worker ownership separate", linuxRunbook.includes("npm run worker:jobs -- --loop --poll-ms 5000 --lease-ms 60000"));

  const cliText = readText("scripts/enqueueScheduledFeed.ts");
  assert("CLI supports --dry-run", cliText.includes("--dry-run"));
  assert("CLI dry-run avoids pool construction", cliText.includes("args.dryRun ? null : getPgPool()"));
  assert("CLI prints JSON summary", cliText.includes("JSON.stringify(result, null, 2)"));

  assert("no live execution job types introduced", JOB_TYPES.every((jobType) => !FORBIDDEN_LIVE_JOB_TYPES.includes(jobType as never)));
  for (const file of [
    "lib/jobs/scheduler/scheduledFeed.ts",
    "app/api/jobs/schedule/route.ts",
    "scripts/enqueueScheduledFeed.ts",
  ]) {
    const text = readText(file);
    for (const forbidden of FORBIDDEN_LIVE_JOB_TYPES) {
      assert(`${file} does not reference ${forbidden}`, !text.includes(forbidden));
    }
  }
}

async function main(): Promise<void> {
  await runClosedBarChecks();
  await runPlanChecks();
  await runEnqueueChecks();
  runAuthChecks();
  await runPaperMonitorChecks();
  runStaticChecks();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
