import type { Pool } from "pg";
import { DashboardSnapshotStore } from "@/lib/jobs/dashboardSnapshotStore";
import { PostgresJobStore } from "@/lib/jobs/postgresJobStore";
import {
  SCHEDULED_FEED_NAME,
  buildScheduledFeedPlan,
  enqueueScheduledFeed,
} from "@/lib/jobs/scheduler";
import {
  FORBIDDEN_LIVE_JOB_TYPES,
  JOB_TYPES,
  assertNoLiveExecutionJobTypes,
  type JobPayload,
  validateJobPayload,
} from "@/lib/jobs/types";
import { closePgPool, getPgPool } from "@/lib/storage";

const REQUIRED_TABLES = [
  "jobs",
  "job_events",
  "dashboard_snapshots",
  "market_bars",
  "feature_snapshots",
  "regime_snapshots",
  "strategy_signals",
] as const;

const REQUIRED_INDEXES = [
  "jobs_dedupe_active",
  "jobs_claimable",
  "jobs_expired_leases",
  "jobs_status_recent",
  "job_events_by_job",
  "dashboard_snapshots_latest",
  "dashboard_snapshots_source_job",
] as const;

const REQUIRED_JOB_CONSTRAINTS = [
  "jobs_status_check",
  "jobs_job_type_check",
  "jobs_payload_job_type_matches",
  "jobs_attempts_nonnegative",
  "jobs_max_attempts_positive",
  "jobs_attempts_lte_max_attempts",
  "jobs_priority_nonnegative",
] as const;

const FIXED_NOW = "2026-06-18T15:05:00.000Z";
const FIXED_CLOSED_BAR_TS = "2026-06-18T14:00:00.000Z";
/** P10C: daily context stages dedupe against the closed daily bar, not FIXED_CLOSED_BAR_TS. */
const FIXED_DAILY_CLOSED_BAR_TS = "2026-06-17T00:00:00.000Z";
const DAILY_CONTEXT_STAGE_NAMES = new Set(["daily.market.ingest.latest", "daily.features.compute"]);

let failures = 0;

function check(label: string, condition: boolean, details?: unknown): void {
  if (condition) {
    console.log(`PASS: ${label}`);
    return;
  }
  failures++;
  console.log(`FAIL: ${label}`);
  if (details !== undefined) console.log("      ", details);
}

function printEnvironmentPresence(): void {
  console.log(`SUPABASE_DB_URL present: ${process.env.SUPABASE_DB_URL?.trim() ? "yes" : "no"}`);
  console.log(`DATABASE_URL present: ${process.env.DATABASE_URL?.trim() ? "yes" : "no"}`);
  console.log(`SCHEDULER_SECRET present: ${process.env.SCHEDULER_SECRET?.trim() ? "yes" : "no"}`);
}

function validPayloads(): JobPayload[] {
  return [
    {
      jobType: "market.ingest.latest",
      symbols: ["BTC-USD"],
      exchange: "COINBASE",
      timeframe: "1h",
      source: "coinbase",
      closedBarsOnly: true,
    },
    {
      jobType: "features.compute",
      symbols: ["BTC-USD"],
      exchange: "COINBASE",
      timeframe: "1h",
      featureVersion: "validation",
    },
    {
      jobType: "regime.compute",
      symbols: ["BTC-USD"],
      exchange: "COINBASE",
      timeframe: "1h",
      regimeModelVersion: "validation",
      source: "persisted_features",
    },
    {
      jobType: "strategies.evaluate",
      symbols: ["BTC-USD"],
      exchange: "COINBASE",
      timeframe: "1h",
    },
    {
      jobType: "paper.monitor",
      symbols: ["BTC-USD"],
      exchange: "COINBASE",
      timeframe: "1h",
    },
    {
      jobType: "dashboard.snapshot",
      snapshotType: "dashboard",
    },
    {
      jobType: "telegram.refresh",
      chatId: "validation",
      requestedBy: "telegram",
    },
  ];
}

async function tableNames(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])`,
    [REQUIRED_TABLES],
  );
  return new Set(rows.map((row) => row.table_name));
}

async function indexNames(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ indexname: string }>(
    `select indexname
       from pg_indexes
      where schemaname = 'public'
        and indexname = any($1::text[])`,
    [REQUIRED_INDEXES],
  );
  return new Set(rows.map((row) => row.indexname));
}

async function jobConstraints(pool: Pool): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ name: string; definition: string }>(
    `select constraint_name as name,
            pg_get_constraintdef(c.oid) as definition
       from information_schema.table_constraints tc
       join pg_constraint c on c.conname = tc.constraint_name
       join pg_class r on r.oid = c.conrelid and r.relname = tc.table_name
       join pg_namespace n on n.oid = r.relnamespace and n.nspname = tc.table_schema
      where tc.table_schema = 'public'
        and tc.table_name = 'jobs'
        and tc.constraint_name = any($1::text[])`,
    [REQUIRED_JOB_CONSTRAINTS],
  );
  return new Map(rows.map((row) => [row.name, row.definition]));
}

async function countJobs(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: number }>("select count(*)::integer as count from jobs");
  return rows[0].count;
}

async function main(): Promise<void> {
  console.log("=== environment ===");
  printEnvironmentPresence();
  const hasDatabaseUrl = Boolean(
    process.env.SUPABASE_DB_URL?.trim() || process.env.DATABASE_URL?.trim(),
  );
  check("database URL is configured", hasDatabaseUrl);
  if (!hasDatabaseUrl) {
    process.exit(1);
  }

  const pool = getPgPool();
  const jobStore = new PostgresJobStore(pool);
  const snapshotStore = new DashboardSnapshotStore(pool);
  let validationJobId: string | null = null;

  try {
    console.log("\n=== schema readiness ===");
    const tables = await tableNames(pool);
    for (const table of REQUIRED_TABLES) {
      check(`required table exists: ${table}`, tables.has(table));
    }

    const indexes = await indexNames(pool);
    for (const index of REQUIRED_INDEXES) {
      check(`required index exists: ${index}`, indexes.has(index));
    }

    const constraints = await jobConstraints(pool);
    for (const constraint of REQUIRED_JOB_CONSTRAINTS) {
      check(`required jobs constraint exists: ${constraint}`, constraints.has(constraint));
    }
    const jobTypeDefinition = constraints.get("jobs_job_type_check") ?? "";
    check(
      "database job-type constraint includes every runtime job type",
      JOB_TYPES.every((jobType) => jobTypeDefinition.includes(jobType)),
    );
    check(
      "database job-type constraint excludes forbidden live execution types",
      FORBIDDEN_LIVE_JOB_TYPES.every((jobType) => !jobTypeDefinition.includes(jobType)),
    );

    console.log("\n=== runtime safety ===");
    const acceptedTypes = validPayloads().map((payload) => validateJobPayload(payload).jobType);
    check(
      "runtime validation accepts every required job type",
      JOB_TYPES.every((jobType) => acceptedTypes.includes(jobType)),
      { acceptedTypes },
    );
    assertNoLiveExecutionJobTypes();
    check(
      "runtime job allowlist contains no forbidden live execution type",
      JOB_TYPES.every((jobType) => !FORBIDDEN_LIVE_JOB_TYPES.includes(jobType as never)),
    );
    for (const forbiddenJobType of FORBIDDEN_LIVE_JOB_TYPES) {
      let rejected = false;
      try {
        validateJobPayload({ jobType: forbiddenJobType });
      } catch {
        rejected = true;
      }
      check(`runtime rejects forbidden job type: ${forbiddenJobType}`, rejected);
    }

    console.log("\n=== DB-backed queue and snapshots ===");
    const timestamp = new Date().toISOString();
    const validationJob = await jobStore.enqueueJob(
      { jobType: "dashboard.snapshot", snapshotType: "dashboard" },
      {
        priority: 1_000,
        maxAttempts: 1,
        dedupeKey: `validation:p8:${timestamp}:dashboard.snapshot`,
        runAfter: new Date(Date.now() + 60 * 60 * 1_000),
      },
    );
    validationJobId = validationJob.publicId;
    check("safe validation dashboard.snapshot job enqueued", validationJob.status === "queued");

    const fetched = await jobStore.fetchJob(validationJob.publicId);
    check(
      "validation job fetches by public id",
      fetched?.publicId === validationJob.publicId && fetched.jobType === "dashboard.snapshot",
    );

    const active = await jobStore.listJobs({ status: ["queued", "running"], limit: 500 });
    check(
      "active job listing contains validation job",
      active.some((job) => job.publicId === validationJob.publicId),
    );

    const cancelled = await jobStore.cancelJob(validationJob.publicId, "P8 operational validation cleanup");
    check("validation job cancels cleanly", cancelled.status === "cancelled");
    validationJobId = null;

    const latestSnapshot = await snapshotStore.fetchLatestSnapshot({
      snapshotType: "dashboard",
      includeExpired: false,
    });
    check(
      "latest dashboard snapshot fetch completes without crashing",
      latestSnapshot === null || latestSnapshot.snapshotType === "dashboard",
    );

    console.log("\n=== scheduler plan and dry run ===");
    const plan = buildScheduledFeedPlan({
      now: FIXED_NOW,
      closedBarTs: FIXED_CLOSED_BAR_TS,
      env: { NODE_ENV: "test" },
    });
    check("scheduled feed name matches contract", plan.feedName === SCHEDULED_FEED_NAME);
    check("scheduled feed plan contains eight stages (incl. P10C daily context)", plan.stages.length === 8);
    check("scheduled feed uses fixed closed bar", plan.closedBarTs === FIXED_CLOSED_BAR_TS);
    check("scheduled feed daily context uses the fixed daily closed bar", plan.dailyClosedBarTs === FIXED_DAILY_CLOSED_BAR_TS);
    check(
      "every scheduled dedupe key includes the correct closed bar (hourly or daily)",
      plan.stages.every((stage) =>
        stage.dedupeKey.includes(DAILY_CONTEXT_STAGE_NAMES.has(stage.stage) ? FIXED_DAILY_CLOSED_BAR_TS : FIXED_CLOSED_BAR_TS),
      ),
    );

    const jobsBeforeDryRun = await countJobs(pool);
    const dryRun = await enqueueScheduledFeed({
      dryRun: true,
      now: FIXED_NOW,
      closedBarTs: FIXED_CLOSED_BAR_TS,
      env: { NODE_ENV: "test" },
    });
    const jobsAfterDryRun = await countJobs(pool);
    check("scheduled feed dry run succeeds", dryRun.success && dryRun.dryRun);
    check(
      "scheduled feed dry run plans eight jobs",
      dryRun.jobs.length === 8 && dryRun.jobs.every((job) => job.action === "dry_run"),
    );
    check("scheduled feed dry run does not mutate jobs", jobsAfterDryRun === jobsBeforeDryRun);
  } catch (error) {
    failures++;
    console.error("FAIL: operational validation aborted");
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    if (validationJobId) {
      try {
        const job = await jobStore.fetchJob(validationJobId);
        if (job?.status === "queued" || job?.status === "running") {
          await jobStore.cancelJob(validationJobId, "P8 operational validation cleanup after failure");
        }
      } catch (error) {
        failures++;
        console.error("FAIL: validation job cleanup failed");
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
    await closePgPool();
  }

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await closePgPool().catch(() => undefined);
  process.exit(1);
});
