import { Pool } from "pg";
import {
  DashboardSnapshotStore,
  JOB_TYPES,
  FORBIDDEN_LIVE_JOB_TYPES,
  PostgresJobStore,
  assertNoLiveExecutionJobTypes,
  type JobPayload,
  validateJobPayload,
} from "@/lib/jobs";

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

async function expectReject(label: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(label, threw);
}

const marketPayload: JobPayload = {
  jobType: "market.ingest.latest",
  symbols: ["BTC-USD"],
  exchange: "COINBASE",
  timeframe: "1h",
  source: "coinbase",
  closedBarsOnly: true,
};

const featuresPayload: JobPayload = {
  jobType: "features.compute",
  symbols: ["BTC-USD"],
  exchange: "COINBASE",
  timeframe: "1h",
  featureVersion: "features.test.v1",
};

const regimePayload: JobPayload = {
  jobType: "regime.compute",
  symbols: ["BTC-USD"],
  exchange: "COINBASE",
  timeframe: "1h",
  regimeModelVersion: "regime.test.v1",
  source: "persisted_features",
};

const strategyPayload: JobPayload = {
  jobType: "strategies.evaluate",
  symbols: ["BTC-USD"],
  exchange: "COINBASE",
  timeframe: "1h",
  strategyIds: ["momentum_continuation"],
};

const paperPayload: JobPayload = {
  jobType: "paper.monitor",
  symbols: ["BTC-USD"],
  exchange: "COINBASE",
  timeframe: "1h",
};

const dashboardPayload: JobPayload = {
  jobType: "dashboard.snapshot",
  snapshotType: "dashboard",
  symbols: ["BTC-USD"],
};

const telegramSnapshotPayload: JobPayload = {
  jobType: "dashboard.snapshot",
  snapshotType: "telegram",
  symbols: ["BTC-USD"],
};

function dashboardSnapshotPayloadFor(symbol: string): JobPayload {
  return {
    jobType: "dashboard.snapshot",
    snapshotType: "dashboard",
    symbols: [symbol],
  };
}

const telegramPayload: JobPayload = {
  jobType: "telegram.refresh",
  chatId: "123",
  symbol: "BTC-USD",
  requestedBy: "telegram",
};

function runPayloadValidationChecks(): void {
  console.log("\n=== job payload validation ===");
  for (const payload of [
    marketPayload,
    featuresPayload,
    regimePayload,
    strategyPayload,
    paperPayload,
    dashboardPayload,
    telegramSnapshotPayload,
    telegramPayload,
  ]) {
    eq(`validates ${payload.jobType}`, validateJobPayload(payload).jobType, payload.jobType);
  }

  assertNoLiveExecutionJobTypes();
  assert("no live execution job types exist", JOB_TYPES.every((t) => !FORBIDDEN_LIVE_JOB_TYPES.includes(t as never)));
  assert("job type list is unique", new Set(JOB_TYPES).size === JOB_TYPES.length);
}

async function countEvents(pool: Pool, jobId: number, eventType?: string): Promise<number> {
  const values: unknown[] = [jobId];
  const typeClause = eventType ? "and event_type = $2" : "";
  if (eventType) values.push(eventType);
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count from job_events where job_id = $1 ${typeClause}`,
    values,
  );
  return Number(rows[0]?.count ?? 0);
}

async function runPostgresChecks(pool: Pool): Promise<void> {
  console.log("\n=== postgres job store ===");
  await pool.query("truncate table job_events, dashboard_snapshots, jobs restart identity cascade");

  const jobs = new PostgresJobStore(pool);
  const snapshots = new DashboardSnapshotStore(pool);

  const dedupeJob = await jobs.enqueueJob(dashboardPayload, { dedupeKey: "dashboard-refresh", priority: 10 });
  assert("enqueue job", dedupeJob.status === "queued" && dedupeJob.jobType === "dashboard.snapshot", dedupeJob);
  eq("enqueue writes event", await countEvents(pool, dedupeJob.id, "job_enqueued"), 1);

  const dedupeAgain = await jobs.enqueueJob(dashboardPayload, { dedupeKey: "dashboard-refresh", priority: 10 });
  eq("dedupe active job", dedupeAgain.publicId, dedupeJob.publicId);
  eq("dedupe writes event", await countEvents(pool, dedupeJob.id, "job_deduped"), 1);

  const fetched = await jobs.fetchJob(dedupeJob.publicId);
  eq("fetch job", fetched?.publicId, dedupeJob.publicId);

  const queued = await jobs.listJobs({ status: "queued" });
  assert("list queued jobs", queued.some((job) => job.publicId === dedupeJob.publicId));

  const claimed = await jobs.claimNextJob("worker-a", 1_000);
  eq("claim next job", claimed?.publicId, dedupeJob.publicId);
  eq("claim increments attempts", claimed?.attempts, 1);
  eq("claim writes event", await countEvents(pool, dedupeJob.id, "job_claimed"), 1);

  const skipped = await jobs.claimNextJob("worker-b", 1_000);
  eq("claim skips locked/running jobs", skipped, null);

  const heartbeat = await jobs.heartbeatJob(claimed!.publicId, "worker-a", 60_000);
  assert(
    "heartbeat extends lease",
    heartbeat.leaseExpiresAt !== null &&
      claimed!.leaseExpiresAt !== null &&
      Date.parse(heartbeat.leaseExpiresAt) > Date.parse(claimed!.leaseExpiresAt),
    { before: claimed!.leaseExpiresAt, after: heartbeat.leaseExpiresAt },
  );

  const completeResult = { nested: { ok: true }, count: 3 };
  const completed = await jobs.completeJob(claimed!.id, "worker-a", completeResult);
  eq("complete job stores result", completed.result, completeResult);
  eq("complete job status", completed.status, "succeeded");
  eq("complete writes event", await countEvents(pool, completed.id, "job_succeeded"), 1);

  const retryJob = await jobs.enqueueJob(featuresPayload, { maxAttempts: 3 });
  const retryClaimed = await jobs.claimNextJob("worker-retry", 1_000);
  eq("claim retry job", retryClaimed?.publicId, retryJob.publicId);
  const retried = await jobs.failJob(retryClaimed!.id, "worker-retry", "temporary failure", { retryable: true });
  eq("fail retryable job requeues when attempts remain", retried.status, "queued");
  assert("retryable failure sets future run_after", Date.parse(retried.runAfter) > Date.now() - 1_000, retried);

  const deadJob = await jobs.enqueueJob(regimePayload, { maxAttempts: 1 });
  const deadClaimed = await jobs.claimNextJob("worker-dead", 1_000);
  eq("claim dead candidate", deadClaimed?.publicId, deadJob.publicId);
  const dead = await jobs.failJob(deadClaimed!.id, "worker-dead", "exhausted", { retryable: true });
  eq("fail retryable job marks dead after max attempts", dead.status, "dead");
  eq("dead writes event", await countEvents(pool, dead.id, "job_dead"), 1);

  const failedJob = await jobs.enqueueJob(strategyPayload, { maxAttempts: 3 });
  const failedClaimed = await jobs.claimNextJob("worker-failed", 1_000);
  eq("claim non-retry candidate", failedClaimed?.publicId, failedJob.publicId);
  const failedTerminal = await jobs.failJob(failedClaimed!.id, "worker-failed", "bad payload", { retryable: false });
  eq("fail non-retryable job marks failed", failedTerminal.status, "failed");

  const recoverQueueJob = await jobs.enqueueJob(paperPayload, { maxAttempts: 3 });
  const recoverQueueClaimed = await jobs.claimNextJob("worker-expired", 1_000);
  eq("claim recover queued candidate", recoverQueueClaimed?.publicId, recoverQueueJob.publicId);
  await pool.query("update jobs set lease_expires_at = now() - interval '1 second' where id = $1", [recoverQueueClaimed!.id]);
  const recoveredQueued = await jobs.recoverExpiredJobs(new Date());
  assert(
    "recover expired running lease into queued",
    recoveredQueued.requeued.some((job) => job.id === recoverQueueClaimed!.id),
    recoveredQueued,
  );

  const recoverDeadJob = await jobs.enqueueJob(telegramPayload, { maxAttempts: 1 });
  const recoverDeadClaimed = await jobs.claimNextJob("worker-expired-dead", 1_000);
  eq("claim recover dead candidate", recoverDeadClaimed?.publicId, recoverDeadJob.publicId);
  await pool.query("update jobs set lease_expires_at = now() - interval '1 second' where id = $1", [recoverDeadClaimed!.id]);
  const recoveredDead = await jobs.recoverExpiredJobs(new Date());
  assert(
    "recover expired running lease into dead when max attempts reached",
    recoveredDead.dead.some((job) => job.id === recoverDeadClaimed!.id),
    recoveredDead,
  );

  const cancelPayload: JobPayload = {
    jobType: "dashboard.snapshot",
    snapshotType: "dashboard",
    symbols: ["ETH-USD"],
  };
  const cancelJob = await jobs.enqueueJob(cancelPayload, { dedupeKey: "cancel-me" });
  const cancelled = await jobs.cancelJob(cancelJob.publicId, "smoke cancel");
  eq("cancel queued job", cancelled.status, "cancelled");

  const appended = await jobs.appendJobEvent(cancelled.id, "smoke_note", "manual note", { roundTrip: true });
  eq("append job events", appended.eventType, "smoke_note");

  assert(
    "job row update and event append occur together",
    completed.status === "succeeded" && (await countEvents(pool, completed.id, "job_succeeded")) === 1,
  );

  const fetchedCompleted = await jobs.fetchJob(completed.publicId);
  eq("payload/result metadata round-trips", fetchedCompleted?.result, completeResult);

  console.log("\n=== dashboard snapshot store ===");
  const now = Date.now();
  await snapshots.insertSnapshot({
    snapshotType: "signals",
    symbol: "BTC-USD",
    timeframe: "1h",
    payload: { version: 1 },
    sourceJobId: completed.id,
    generatedAt: new Date(now - 120_000),
    expiresAt: new Date(now + 3_600_000),
  });
  const liveLatest = await snapshots.insertSnapshot({
    snapshotType: "signals",
    symbol: "BTC-USD",
    timeframe: "1h",
    payload: { version: 2 },
    sourceJobId: completed.id,
    generatedAt: new Date(now - 60_000),
    expiresAt: new Date(now + 3_600_000),
  });
  const expiredLatest = await snapshots.insertSnapshot({
    snapshotType: "signals",
    symbol: "BTC-USD",
    timeframe: "1h",
    payload: { version: 3, expired: true },
    sourceJobId: completed.id,
    generatedAt: new Date(now),
    expiresAt: new Date(now - 1_000),
  });
  const latestDefault = await snapshots.fetchLatestSnapshot({
    snapshotType: "signals",
    symbol: "BTC-USD",
    timeframe: "1h",
  });
  eq("dashboard snapshot insert/fetch latest", latestDefault?.publicId, liveLatest.publicId);
  eq("fetchLatestSnapshot excludes expired by default", latestDefault?.publicId, liveLatest.publicId);
  const latestWithExpired = await snapshots.fetchLatestSnapshot({
    snapshotType: "signals",
    symbol: "BTC-USD",
    timeframe: "1h",
    includeExpired: true,
  });
  eq("fetchLatestSnapshot can include expired when requested", latestWithExpired?.publicId, expiredLatest.publicId);

  console.log("\n=== postgres constraints ===");
  await expectReject(
    "invalid job type rejected",
    () => pool.query(
      `insert into jobs (job_type, status, payload)
       values ('unknown.job', 'queued', $1::jsonb)`,
      [JSON.stringify({ jobType: "unknown.job" })],
    ),
  );
  await expectReject(
    "payload jobType mismatch rejected",
    () => pool.query(
      `insert into jobs (job_type, status, payload)
       values ('features.compute', 'queued', $1::jsonb)`,
      [JSON.stringify({ jobType: "regime.compute" })],
    ),
  );
  await expectReject(
    "forbidden live job type rejected",
    () => pool.query(
      `insert into jobs (job_type, status, payload)
       values ('live.execute', 'queued', $1::jsonb)`,
      [JSON.stringify({ jobType: "live.execute" })],
    ),
  );

  await expectReject(
    "runtime invalid job type rejected",
    () => jobs.enqueueJob({ jobType: "unknown.job" } as unknown as JobPayload),
  );
  await expectReject(
    "runtime forbidden live job type rejected",
    () => jobs.enqueueJob({ jobType: "live.execute" } as unknown as JobPayload),
  );

  await expectReject(
    "db rejects attempts greater than max_attempts",
    () => pool.query(
      `insert into jobs (job_type, status, payload, attempts, max_attempts)
       values ('dashboard.snapshot', 'queued', $1::jsonb, 2, 1)`,
      [JSON.stringify(dashboardPayload)],
    ),
  );

  console.log("\n=== stale worker lease guards ===");
  const staleHeartbeatJob = await jobs.enqueueJob(dashboardSnapshotPayloadFor("STALE-HEARTBEAT"));
  const staleHeartbeatClaimed = await jobs.claimNextJob("worker-stale-heartbeat", 1_000);
  eq("claim stale heartbeat candidate", staleHeartbeatClaimed?.publicId, staleHeartbeatJob.publicId);
  await pool.query("update jobs set lease_expires_at = now() - interval '1 second' where id = $1", [staleHeartbeatClaimed!.id]);
  await expectReject(
    "stale worker heartbeat after lease expiry rejected",
    () => jobs.heartbeatJob(staleHeartbeatClaimed!.id, "worker-stale-heartbeat", 1_000),
  );

  const staleCompleteJob = await jobs.enqueueJob(dashboardSnapshotPayloadFor("STALE-COMPLETE"));
  const staleCompleteClaimed = await jobs.claimNextJob("worker-stale-complete", 1_000);
  eq("claim stale complete candidate", staleCompleteClaimed?.publicId, staleCompleteJob.publicId);
  await pool.query("update jobs set lease_expires_at = now() - interval '1 second' where id = $1", [staleCompleteClaimed!.id]);
  await expectReject(
    "stale worker completion after lease expiry rejected",
    () => jobs.completeJob(staleCompleteClaimed!.id, "worker-stale-complete", { shouldNotWrite: true }),
  );

  const staleFailJob = await jobs.enqueueJob(dashboardSnapshotPayloadFor("STALE-FAIL"));
  const staleFailClaimed = await jobs.claimNextJob("worker-stale-fail", 1_000);
  eq("claim stale fail candidate", staleFailClaimed?.publicId, staleFailJob.publicId);
  await pool.query("update jobs set lease_expires_at = now() - interval '1 second' where id = $1", [staleFailClaimed!.id]);
  await expectReject(
    "stale worker failure after lease expiry rejected",
    () => jobs.failJob(staleFailClaimed!.id, "worker-stale-fail", "too late", { retryable: true }),
  );
}

async function main(): Promise<void> {
  runPayloadValidationChecks();

  const dbUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    const message = "postgres job lifecycle suite skipped - set SUPABASE_DB_URL or DATABASE_URL to enable";
    if (process.env.REQUIRE_DB_SMOKE === "1") {
      console.log(`\nFAIL: ${message} (REQUIRE_DB_SMOKE=1)`);
      failed++;
    } else {
      console.log(`\n(SKIP: ${message}; set REQUIRE_DB_SMOKE=1 in CI to fail instead)`);
    }
  } else {
    const pool = new Pool({ connectionString: dbUrl });
    try {
      await runPostgresChecks(pool);
    } finally {
      await pool.end();
    }
  }

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
