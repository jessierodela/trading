import fs from "node:fs";
import path from "node:path";
import {
  buildP8OpsSummary,
  type P8OpsJobRow,
  type P8OpsSnapshotRow,
} from "@/lib/ops/p8Summary";

let failed = 0;

function assert(label: string, condition: boolean, details?: unknown): void {
  if (condition) {
    console.log(`PASS: ${label}`);
    return;
  }
  console.log(`FAIL: ${label}`);
  if (details !== undefined) console.log("       ", details);
  failed++;
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const matches = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, matches, matches ? undefined : { actual, expected });
}

function readText(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

function job(overrides: Partial<P8OpsJobRow> = {}): P8OpsJobRow {
  return {
    public_id: "11111111-1111-4111-8111-111111111111",
    job_type: "market.ingest.latest",
    status: "queued",
    priority: 10,
    result: {},
    dedupe_key: null,
    run_after: "2026-06-23T10:05:00.000Z",
    attempts: 0,
    max_attempts: 3,
    lease_expires_at: null,
    heartbeat_at: null,
    started_at: null,
    completed_at: null,
    failed_at: null,
    error: null,
    created_at: "2026-06-23T10:01:00.000Z",
    ...overrides,
  };
}

function runShapeAndEmptyChecks(): void {
  console.log("\n=== empty operations summary ===");
  const summary = buildP8OpsSummary({ now: new Date("2026-06-23T12:00:00.000Z") });
  eq("summary exposes expected top-level keys", Object.keys(summary), [
    "generatedAt",
    "scheduler",
    "queue",
    "worker",
    "pipeline",
    "snapshot",
    "regime",
    "readiness",
  ]);
  eq("empty queue derives idle worker", summary.worker.status, "idle");
  eq("empty pipeline exposes six missing stages", summary.pipeline.stages.map((stage) => stage.status), [
    "missing",
    "missing",
    "missing",
    "missing",
    "missing",
    "missing",
  ]);
  eq("missing snapshot remains null", summary.snapshot.latestDashboardSnapshot, null);
  eq("empty signals source is explicit", summary.snapshot.signalsSource, "empty");
  assert("empty regime state is stale", summary.regime.symbols.every((row) => row.stale));
}

function runWorkerAndSchedulerChecks(): void {
  console.log("\n=== queue, worker, and scheduler inference ===");
  const now = new Date("2026-06-23T12:00:00.000Z");
  const running = job({
    status: "running",
    attempts: 1,
    started_at: "2026-06-23T11:59:00.000Z",
    heartbeat_at: "2026-06-23T11:59:30.000Z",
    lease_expires_at: "2026-06-23T12:01:00.000Z",
    dedupe_key: "scheduled:market.ingest.latest:coinbase:COINBASE:1h:2026-06-23T10:00:00.000Z:BTC-USD",
  });
  const queued = job({
    public_id: "22222222-2222-4222-8222-222222222222",
    job_type: "features.compute",
    status: "queued",
    priority: 20,
    run_after: "2026-06-23T10:07:00.000Z",
    dedupe_key: "scheduled:features.compute:COINBASE:1h:2026-06-23T10:00:00.000Z:BTC-USD:v1",
  });
  const summary = buildP8OpsSummary({
    now,
    jobs: [running, queued],
    counts: { queued: 1, running: 1 },
    oldestQueuedAgeSeconds: 120,
    expiredLeaseCount: 0,
  });
  eq("recent heartbeat and active lease derive active worker", summary.worker.status, "active");
  eq("queue counts remain explicit", summary.queue.counts.queued, 1);
  eq("latest scheduled feed closed bar is derived from stage offsets", summary.scheduler.lastScheduledFeed?.closedBarTs, "2026-06-23T10:00:00.000Z");
  eq("scheduled feed keeps missing downstream stages conservative", summary.scheduler.lastScheduledFeed?.stages.at(-1)?.status, "missing");

  const attention = buildP8OpsSummary({
    now,
    jobs: [queued],
    counts: { queued: 1 },
  });
  eq("queued work without recent worker evidence needs attention", attention.worker.status, "attention");

  const completed = buildP8OpsSummary({
    now,
    jobs: [job({
      status: "succeeded",
      attempts: 1,
      started_at: "2026-06-23T11:52:00.000Z",
      completed_at: "2026-06-23T11:55:00.000Z",
      result: { barsInserted: 5 },
    })],
    counts: { succeeded: 1 },
  });
  eq("recent completion derives recently active worker", completed.worker.status, "recently_active");
  assert("job result is summarized without exposing full payload", completed.queue.recentJobs[0].resultSummary?.includes("barsInserted: 5") === true);
}

function runSnapshotAndReadinessChecks(): void {
  console.log("\n=== persisted snapshot and conservative readiness ===");
  const snapshot: P8OpsSnapshotRow = {
    public_id: "33333333-3333-4333-8333-333333333333",
    generated_at: "2026-06-23T11:58:00.000Z",
    expires_at: "2026-06-23T12:30:00.000Z",
    source_job_public_id: "44444444-4444-4444-8444-444444444444",
    payload: {
      agentResults: [{ signals: [{ symbol: "BTC-USD" }] }],
      activity: [{ id: "event" }],
      confluence: [{ symbol: "ETH-USD" }],
      regimeMap: {
        "BTC-USD": { regime: "TREND_UP", reliability: 0.88 },
      },
      generatedAt: "2026-06-23T11:58:00.000Z",
    },
  };
  const summary = buildP8OpsSummary({
    now: new Date("2026-06-23T12:00:00.000Z"),
    snapshot,
    regimes: [{
      symbol: "BTC-USD",
      regime: "LOW_VOL",
      reliability: "0.91",
      ts: "2026-06-23T11:50:00.000Z",
    }],
  });
  eq("persisted snapshot becomes signals source", summary.snapshot.signalsSource, "dashboard_snapshots");
  eq("snapshot payload counts agent results", summary.snapshot.latestDashboardSnapshot?.payloadSummary.agentResultsCount, 1);
  eq("snapshot payload collects covered symbols", summary.snapshot.latestDashboardSnapshot?.payloadSummary.symbols, ["BTC-USD", "ETH-USD"]);
  eq("regime_snapshots wins over dashboard snapshot fallback", summary.regime.symbols[0].source, "regime_snapshots");
  eq("persisted regime reliability is numeric", summary.regime.symbols[0].reliability, 0.91);

  const mergedItem = summary.readiness.find((item) => item.label === "P8 branch merged to main");
  const supervisorItem = summary.readiness.find((item) => item.label === "Worker loop supervised");
  eq("branch readiness stays unknown without runtime evidence", mergedItem?.status, "unknown");
  eq("supervisor readiness stays unknown without external evidence", supervisorItem?.status, "unknown");
  assert("readiness never claims every item passes", summary.readiness.some((item) => item.status !== "pass"));
}

function runStaticBoundaryChecks(): void {
  console.log("\n=== read-only route boundaries ===");
  const route = readText("app/api/ops/p8/route.ts");
  const service = readText("lib/ops/p8Summary.ts");
  assert("ops route exports GET", route.includes("export async function GET"));
  assert("ops route does not export a mutation handler", !/export async function (POST|PUT|PATCH|DELETE)/.test(route));
  for (const forbiddenImport of ["lib/jobs/worker", "lib/jobs/handlers", "enqueueScheduledFeed", "enqueueJob", "claimNextJob"]) {
    assert(`ops route does not reference ${forbiddenImport}`, !route.includes(forbiddenImport));
  }
  for (const mutation of ["insert into", "update jobs", "delete from", "truncate "]) {
    assert(`ops query service does not contain ${mutation}`, !service.toLowerCase().includes(mutation));
  }
  assert("ops query service reads only approved P8 tables", [
    "from jobs",
    "from job_events",
    "from dashboard_snapshots",
    "from regime_snapshots",
  ].every((fragment) => service.includes(fragment)));

  const signalsRoute = readText("app/api/signals/route.ts");
  assert("signals route adds backward-compatible source metadata", signalsRoute.includes("source: result.source"));
}

function main(): void {
  runShapeAndEmptyChecks();
  runWorkerAndSchedulerChecks();
  runSnapshotAndReadinessChecks();
  runStaticBoundaryChecks();
  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
