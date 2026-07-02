import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import {
  closePgPool,
  detectPgPoolRuntime,
  getPgPool,
  isTransientDbError,
  resolvePgPoolConfig,
  withDbRetry,
  withPooledClient,
} from "@/lib/storage";
import { loadDbHealth } from "@/lib/ops/dbHealth";
import type { JobStore } from "@/lib/jobs/jobStore";
import { runJobWorkerLoop } from "@/lib/jobs/worker";
import { FORBIDDEN_LIVE_JOB_TYPES, JOB_TYPES } from "@/lib/jobs/types";

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

/** Builds an isolated fake env for deterministic env-driven tests. */
function fakeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return overrides as unknown as NodeJS.ProcessEnv;
}

// ─── Pool config: environment-aware sizing ─────────────────────────────────

function runPoolConfigChecks(): void {
  console.log("\n=== pg pool config: environment-aware sizing ===");

  const serverless = resolvePgPoolConfig(fakeEnv({ VERCEL: "1" }));
  eq("serverless runtime detected from VERCEL env", serverless.runtime, "serverless");
  eq("serverless pool max defaults to 1", serverless.max, 1);
  assert(
    "serverless connection timeout is bounded",
    serverless.connectionTimeoutMillis > 0 && serverless.connectionTimeoutMillis <= 10_000,
    serverless,
  );

  const vercelEnv = resolvePgPoolConfig(fakeEnv({ VERCEL_ENV: "production" }));
  eq("VERCEL_ENV alone also detects serverless", vercelEnv.runtime, "serverless");

  const worker = resolvePgPoolConfig(fakeEnv({ PG_POOL_RUNTIME: "worker" }));
  eq("worker runtime detected from PG_POOL_RUNTIME", worker.runtime, "worker");
  eq("worker pool max defaults to 2", worker.max, 2);
  eq("worker idle timeout defaults to 30s", worker.idleTimeoutMillis, 30_000);

  const local = resolvePgPoolConfig(fakeEnv());
  eq("local runtime is the fallback with no signals present", local.runtime, "local");
  eq("local pool max defaults to 10", local.max, 10);

  const overridden = resolvePgPoolConfig(fakeEnv({ VERCEL: "1", PG_POOL_MAX: "5" }));
  eq("PG_POOL_MAX overrides the runtime-specific default", overridden.max, 5);

  const explicitWorkerMax = resolvePgPoolConfig(fakeEnv({ PG_POOL_RUNTIME: "worker", PG_POOL_MAX_WORKER: "4" }));
  eq("PG_POOL_MAX_WORKER overrides the worker default", explicitWorkerMax.max, 4);

  eq(
    "PG_POOL_RUNTIME wins over VERCEL auto-detection",
    detectPgPoolRuntime(fakeEnv({ VERCEL: "1", PG_POOL_RUNTIME: "local" })),
    "local",
  );
}

// ─── Pool singleton + error handler dedup ──────────────────────────────────

async function runPoolSingletonChecks(): Promise<void> {
  console.log("\n=== pg pool: singleton caching + error handler registration ===");
  await closePgPool();
  try {
    const env = fakeEnv({ DATABASE_URL: "postgres://smoke:smoke@127.0.0.1:59999/smoke_db_stability" });
    const poolA = getPgPool({ env, runtime: "local" });
    const poolB = getPgPool({ env, runtime: "local" });
    assert("getPgPool returns the same cached instance across calls", poolA === poolB);
    eq("pool registers exactly one error listener (no hot-reload duplication)", poolA.listenerCount("error"), 1);
  } finally {
    await closePgPool();
  }
}

// ─── withPooledClient: checkout / release / error-listener safety ─────────

interface FakeErrorEmitter {
  errorListeners: Array<(err: Error) => void>;
}

function fakeClient(events: FakeErrorEmitter) {
  return {
    released: false,
    on(event: string, listener: (err: Error) => void) {
      if (event === "error") events.errorListeners.push(listener);
      return this;
    },
    off(event: string, listener: (err: Error) => void) {
      if (event === "error") {
        const idx = events.errorListeners.indexOf(listener);
        if (idx >= 0) events.errorListeners.splice(idx, 1);
      }
      return this;
    },
    release(this: { released: boolean }) {
      this.released = true;
    },
  };
}

async function runWithPooledClientChecks(): Promise<void> {
  console.log("\n=== withPooledClient: checkout/release/error-listener safety ===");

  const events: FakeErrorEmitter = { errorListeners: [] };
  const client = fakeClient(events);
  const pool = { async connect() { return client; } } as unknown as Pool;

  let listenerCountDuringUse = -1;
  const result = await withPooledClient(pool, async () => {
    listenerCountDuringUse = events.errorListeners.length;
    return "ok";
  });
  eq("withPooledClient returns fn()'s result", result, "ok");
  eq("error listener attached during checkout", listenerCountDuringUse, 1);
  assert("client released after successful use", client.released, client);
  eq("error listener removed after release", events.errorListeners.length, 0);

  const failingEvents: FakeErrorEmitter = { errorListeners: [] };
  const failingClient = fakeClient(failingEvents);
  const failingPool = { async connect() { return failingClient; } } as unknown as Pool;
  let threw = false;
  try {
    await withPooledClient(failingPool, async () => {
      throw new Error("boom");
    });
  } catch {
    threw = true;
  }
  assert("withPooledClient rethrows errors from fn()", threw);
  assert("client is released even when fn() throws", failingClient.released, failingClient);
  eq("error listener removed even when fn() throws", failingEvents.errorListeners.length, 0);
}

// ─── Transient DB error classification ─────────────────────────────────────

function codeError(code: string, message = "boom"): Error {
  return Object.assign(new Error(message), { code });
}

function runTransientErrorClassificationChecks(): void {
  console.log("\n=== transient DB error classification ===");
  assert("ECHECKOUTTIMEOUT is transient", isTransientDbError(codeError("ECHECKOUTTIMEOUT")));
  assert("EDBHANDLEREXITED is transient", isTransientDbError(codeError("EDBHANDLEREXITED")));
  assert("ETIMEDOUT is transient", isTransientDbError(codeError("ETIMEDOUT")));
  assert("ECONNRESET is transient", isTransientDbError(codeError("ECONNRESET")));
  assert("57P01 admin_shutdown is transient", isTransientDbError(codeError("57P01")));
  assert("57P03 cannot_connect_now is transient", isTransientDbError(codeError("57P03")));
  assert("53300 too_many_connections is transient", isTransientDbError(codeError("53300")));
  assert("08006 connection_failure is transient", isTransientDbError(codeError("08006")));
  assert(
    "'connection terminated unexpectedly' message is transient",
    isTransientDbError(new Error("Connection terminated unexpectedly")),
  );
  assert(
    "'connection to database closed' message is transient",
    isTransientDbError(new Error("connection to database closed")),
  );
  assert(
    "pool checkout timeout message is transient",
    isTransientDbError(new Error("unable to check out connection from the pool after 15000ms in Transaction mode")),
  );
  assert("XX000 with pooler wording is transient", isTransientDbError(codeError("XX000", "pooler error: connection reset")));
  assert("bare XX000 without connection wording is NOT transient", !isTransientDbError(codeError("XX000", "internal_error")));
  assert("missing-table (42P01) error is NOT transient", !isTransientDbError(codeError("42P01", 'relation "risk_decisions" does not exist')));
  assert("unique violation (23505) is NOT transient", !isTransientDbError(codeError("23505", "duplicate key value violates unique constraint")));
  assert("non-Error values are NOT transient", !isTransientDbError("some string"));
  assert("undefined is NOT transient", !isTransientDbError(undefined));
}

// ─── withDbRetry: bounded retry with backoff ───────────────────────────────

async function runWithDbRetryChecks(): Promise<void> {
  console.log("\n=== withDbRetry: bounded retry with backoff ===");
  const sleeps: number[] = [];
  const fakeSleep = async (ms: number) => {
    sleeps.push(ms);
  };

  let calls = 0;
  const eventuallySucceeds = await withDbRetry(
    "smoke.eventualSuccess",
    async () => {
      calls++;
      if (calls < 3) throw codeError("ECONNRESET", "connection terminated unexpectedly");
      return "ok";
    },
    { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2, sleepFn: fakeSleep },
  );
  eq("withDbRetry retries transient errors and eventually succeeds", eventuallySucceeds, "ok");
  eq("withDbRetry made exactly the attempts needed to succeed", calls, 3);
  eq("withDbRetry slept once per retry (not per attempt)", sleeps.length, 2);

  sleeps.length = 0;
  let attemptsAfterExhaustion = 0;
  let exhaustedThrew = false;
  try {
    await withDbRetry(
      "smoke.alwaysFails",
      async () => {
        attemptsAfterExhaustion++;
        throw codeError("ECONNRESET", "connection terminated unexpectedly");
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleepFn: fakeSleep },
    );
  } catch {
    exhaustedThrew = true;
  }
  assert("withDbRetry rethrows once max attempts are exhausted", exhaustedThrew);
  eq("withDbRetry stops after max attempts", attemptsAfterExhaustion, 3);

  let nonTransientAttempts = 0;
  let nonTransientThrew = false;
  try {
    await withDbRetry(
      "smoke.schemaError",
      async () => {
        nonTransientAttempts++;
        throw codeError("42P01", "relation does not exist");
      },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2, sleepFn: fakeSleep },
    );
  } catch {
    nonTransientThrew = true;
  }
  assert("withDbRetry does not retry schema/programmer errors", nonTransientThrew);
  eq("withDbRetry gives a non-transient error exactly one attempt", nonTransientAttempts, 1);
}

// ─── Worker loop: transient DB failure resilience ──────────────────────────

async function runWorkerLoopTransientFailureChecks(): Promise<void> {
  console.log("\n=== worker loop: does not crash on transient DB failure ===");
  let recoverCalls = 0;
  let claimCalls = 0;

  const store: JobStore = {
    async enqueueJob() { throw new Error("not needed in this smoke"); },
    async fetchJob() { return null; },
    async listJobs() { return []; },
    async claimNextJob() {
      claimCalls++;
      return null;
    },
    async recoverExpiredJobs() {
      recoverCalls++;
      if (recoverCalls <= 2) throw codeError("ECONNRESET", "connection terminated unexpectedly");
      return { requeued: [], dead: [] };
    },
    async heartbeatJob() { throw new Error("not needed in this smoke"); },
    async completeJob() { throw new Error("not needed in this smoke"); },
    async failJob() { throw new Error("not needed in this smoke"); },
    async cancelJob() { throw new Error("not needed in this smoke"); },
    async appendJobEvent() { throw new Error("not needed in this smoke"); },
  };

  const controller = new AbortController();
  let loopThrew: unknown = null;
  const loopPromise = runJobWorkerLoop({
    store,
    workerId: "smoke-db-stability",
    leaseMs: 1_000,
    pollMs: 5,
    signal: controller.signal,
    // maxAttempts: 1 disables withDbRetry's own internal retry, forcing the
    // failure to reach runJobWorkerLoop's outage-backoff-and-continue path.
    dbRetry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 },
    logger: { info() {}, warn() {}, error() {} },
  }).catch((err) => {
    loopThrew = err;
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  controller.abort();
  await loopPromise;

  assert("worker loop does not crash on transient recoverExpiredJobs failures", loopThrew === null, loopThrew);
  assert("worker loop retried recoverExpiredJobs across transient failures", recoverCalls >= 3, recoverCalls);
  assert("worker loop resumed normal polling once the DB recovered", claimCalls >= 1, claimCalls);
}

// ─── db-health: shape and status ───────────────────────────────────────────

async function runDbHealthChecks(): Promise<void> {
  console.log("\n=== db-health: shape and status ===");

  const healthyPool = {
    async query() {
      return { rows: [{ db_now: new Date("2026-07-05T12:00:00.000Z") }] };
    },
  } as unknown as Pool;
  const healthy = await loadDbHealth({
    pool: healthyPool,
    env: fakeEnv({ PG_POOL_RUNTIME: "worker" }),
    now: new Date("2026-07-05T12:00:00.500Z"),
  });
  eq("healthy db-health summary exposes expected keys", Object.keys(healthy), [
    "generatedAt", "ok", "latencyMs", "dbTime", "poolConfig", "error",
  ]);
  eq("healthy db-health reports ok=true", healthy.ok, true);
  assert(
    "healthy db-health reports a non-negative latency",
    typeof healthy.latencyMs === "number" && healthy.latencyMs >= 0,
    healthy,
  );
  eq("healthy db-health reports the resolved pool runtime", healthy.poolConfig.runtime, "worker");
  eq("healthy db-health reports no error", healthy.error, null);

  const failingPool = {
    async query() {
      throw codeError("ECONNRESET", "connection terminated unexpectedly");
    },
  } as unknown as Pool;
  const unhealthy = await loadDbHealth({
    pool: failingPool,
    env: fakeEnv(),
    now: new Date("2026-07-05T12:00:00.500Z"),
  });
  eq("unhealthy db-health reports ok=false", unhealthy.ok, false);
  eq("unhealthy db-health has null latency", unhealthy.latencyMs, null);
  eq("unhealthy db-health has null dbTime", unhealthy.dbTime, null);
  assert(
    "unhealthy db-health surfaces the connectivity error message",
    unhealthy.error?.includes("connection terminated unexpectedly") === true,
    unhealthy,
  );
  eq("unhealthy db-health still reports pool config", unhealthy.poolConfig.runtime, "local");
}

// ─── Static route/handler checks ───────────────────────────────────────────

function runStaticChecks(): void {
  console.log("\n=== static checks: retry wiring, no-store, paper-only, no live execution ===");

  for (const [name, file] of [
    ["p8", "app/api/ops/p8/route.ts"],
    ["risk-gate", "app/api/ops/risk-gate/route.ts"],
    ["db-health", "app/api/ops/db-health/route.ts"],
  ] as const) {
    const text = readText(file);
    assert(`${name} route sets Cache-Control: no-store`, text.includes("no-store"));
    assert(`${name} route returns 503 on failure`, text.includes("503"));
  }

  assert("p8Summary loader retries via withDbRetry", readText("lib/ops/p8Summary.ts").includes("withDbRetry"));
  assert("riskGateSummary loader retries via withDbRetry", readText("lib/ops/riskGateSummary.ts").includes("withDbRetry"));

  const scheduleRoute = readText("app/api/jobs/schedule/route.ts");
  assert("schedule route retries via withDbRetry", scheduleRoute.includes("withDbRetry"));
  assert("schedule route classifies transient failures for 503", scheduleRoute.includes("isTransientDbError"));

  const paperMonitorHandler = readText("lib/jobs/handlers/paperMonitor.ts");
  assert("paper.monitor handler is still marked paperOnly", paperMonitorHandler.includes("paperOnly: true"));
  assert(
    "paper.monitor handler does not create orders or fills",
    !/insertOrder|insertFill/.test(paperMonitorHandler),
  );

  const workerSource = readText("lib/jobs/worker.ts");
  assert(
    "worker.ts has no live broker imports",
    !/alpaca|binance-connector|ccxt|coinbase-advanced|coinbase-pro|liveBrokerClient/i.test(workerSource),
  );

  assert(
    "no live execution job types introduced",
    JOB_TYPES.every((jobType) => !FORBIDDEN_LIVE_JOB_TYPES.includes(jobType as never)),
  );
}

async function main(): Promise<void> {
  runPoolConfigChecks();
  await runPoolSingletonChecks();
  await runWithPooledClientChecks();
  runTransientErrorClassificationChecks();
  await runWithDbRetryChecks();
  await runWorkerLoopTransientFailureChecks();
  await runDbHealthChecks();
  runStaticChecks();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
