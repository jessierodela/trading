import type { Pool } from "pg";
import { DashboardSnapshotStore } from "@/lib/jobs/dashboardSnapshotStore";
import type { JobRecord, JobStore } from "@/lib/jobs/jobStore";
import { PostgresJobStore } from "@/lib/jobs/postgresJobStore";
import { type JobPayload, type JobType, validateJobPayload } from "@/lib/jobs/types";
import {
  JOB_HANDLER_REGISTRY,
  type JobHandler,
  type JobHandlerServices,
  type JobHandlerFailure,
} from "@/lib/jobs/handlers";
import {
  runDashboardRefreshPipeline,
  runMarketIngestLatestPipeline,
  writeDashboardSnapshot,
} from "@/lib/pipeline";
import {
  PgBarStore,
  PgFeatureStore,
  PgRegimeStore,
  PgSignalStore,
} from "@/lib/storage";
import { PostgresPaperTradingStore } from "@/lib/execution";
import { PostgresTradeIntentStore } from "@/lib/tradeIntent";
import { PostgresRiskDecisionStore } from "@/lib/risk/riskDecisionStore";
import { isTransientDbError, withDbRetry, type DbRetryOptions } from "@/lib/storage/dbRetry";

export interface JobWorkerLogger {
  info(message: string, metadata?: unknown): void;
  warn(message: string, metadata?: unknown): void;
  error(message: string, metadata?: unknown): void;
}

export interface JobWorkerOptions {
  store: JobStore;
  workerId: string;
  leaseMs: number;
  pollMs?: number;
  now?: () => Date;
  services?: JobHandlerServices;
  handlers?: Partial<Record<JobType, JobHandler>>;
  logger?: JobWorkerLogger;
  signal?: AbortSignal;
  /** Retry policy for transient DB errors around claim/heartbeat/handler/finalize. */
  dbRetry?: Partial<DbRetryOptions>;
}

export interface JobWorkerOnceResult {
  claimed: boolean;
  job: JobRecord | null;
  status: "no_job" | "succeeded" | "failed" | "dead" | "requeued" | "error";
  finalJob?: JobRecord;
  error?: string;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_LEASE_MS = 60_000;

/** Conservative worker-side retry defaults for transient DB connectivity errors. */
const DEFAULT_DB_RETRY: DbRetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
};

function resolveDbRetry(options: JobWorkerOptions): DbRetryOptions {
  return { ...DEFAULT_DB_RETRY, ...options.dbRetry };
}

const consoleLogger: JobWorkerLogger = {
  info(message, metadata) {
    if (metadata === undefined) console.log(message);
    else console.log(message, metadata);
  },
  warn(message, metadata) {
    if (metadata === undefined) console.warn(message);
    else console.warn(message, metadata);
  },
  error(message, metadata) {
    if (metadata === undefined) console.error(message);
    else console.error(message, metadata);
  },
};

function assertWorkerOptions(options: JobWorkerOptions): void {
  if (options.workerId.trim().length === 0) throw new Error("workerId is required");
  if (!Number.isFinite(options.leaseMs) || options.leaseMs <= 0) {
    throw new Error("leaseMs must be a positive finite number");
  }
  if (options.pollMs !== undefined && (!Number.isFinite(options.pollMs) || options.pollMs <= 0)) {
    throw new Error("pollMs must be a positive finite number");
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("worker shutdown requested"));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new Error("worker shutdown requested"));
      },
      { once: true },
    );
  });
}

function classifyThrownError(err: unknown): JobHandlerFailure {
  const message = err instanceof Error ? err.message : String(err);
  const nonRetryable =
    /handler_not_implemented|invalid_payload|unsupported|unknown job type|forbidden live execution/i.test(message);
  return {
    success: false,
    retryable: !nonRetryable,
    error: nonRetryable ? "handler_non_retryable_error" : "handler_exception",
    result: { message },
  };
}

function finalStatus(job: JobRecord): JobWorkerOnceResult["status"] {
  if (job.status === "succeeded") return "succeeded";
  if (job.status === "failed") return "failed";
  if (job.status === "dead") return "dead";
  if (job.status === "queued") return "requeued";
  return "error";
}

function startHeartbeat(options: JobWorkerOptions, job: JobRecord): {
  signal: AbortSignal;
  stop: () => void;
  getError: () => unknown;
} {
  const controller = new AbortController();
  let heartbeatError: unknown = null;
  const intervalMs = Math.max(10, Math.floor(options.leaseMs / 3));
  let running = false;

  const dbRetry = resolveDbRetry(options);
  const tick = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      await withDbRetry(
        "worker.heartbeat",
        () => options.store.heartbeatJob(job.id, options.workerId, options.leaseMs),
        dbRetry,
      );
    } catch (err) {
      heartbeatError = err;
      controller.abort();
    } finally {
      running = false;
    }
  };

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    signal: controller.signal,
    stop: () => {
      clearInterval(timer);
    },
    getError: () => heartbeatError,
  };
}

export function createJobWorkerServices(pool: Pool): JobHandlerServices {
  return {
    pool,
    barStore: new PgBarStore(pool),
    featureStore: new PgFeatureStore(pool),
    regimeStore: new PgRegimeStore(pool),
    signalStore: new PgSignalStore(pool),
    paperStore: new PostgresPaperTradingStore(pool),
    intentStore: new PostgresTradeIntentStore(pool),
    riskDecisionStore: new PostgresRiskDecisionStore(pool),
    dashboardSnapshotStore: new DashboardSnapshotStore(pool),
    runDashboardRefreshPipeline,
    runMarketIngestLatestPipeline,
    writeDashboardSnapshot,
  };
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** WORKER_DB_RETRY_MAX_ATTEMPTS / _BASE_DELAY_MS / _MAX_DELAY_MS, falling back to DEFAULT_DB_RETRY. */
export function resolveWorkerDbRetryOptions(env: NodeJS.ProcessEnv = process.env): DbRetryOptions {
  return {
    maxAttempts: envInt(env, "WORKER_DB_RETRY_MAX_ATTEMPTS", DEFAULT_DB_RETRY.maxAttempts),
    baseDelayMs: envInt(env, "WORKER_DB_RETRY_BASE_DELAY_MS", DEFAULT_DB_RETRY.baseDelayMs),
    maxDelayMs: envInt(env, "WORKER_DB_RETRY_MAX_DELAY_MS", DEFAULT_DB_RETRY.maxDelayMs),
  };
}

export function createPostgresJobWorkerOptions(input: {
  pool: Pool;
  workerId: string;
  leaseMs?: number;
  pollMs?: number;
  logger?: JobWorkerLogger;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): JobWorkerOptions {
  return {
    store: new PostgresJobStore(input.pool),
    workerId: input.workerId,
    leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
    pollMs: input.pollMs ?? DEFAULT_POLL_MS,
    services: createJobWorkerServices(input.pool),
    logger: input.logger,
    signal: input.signal,
    dbRetry: resolveWorkerDbRetryOptions(input.env ?? process.env),
  };
}

async function failClaimedJob(
  options: JobWorkerOptions,
  job: JobRecord,
  failure: JobHandlerFailure,
): Promise<JobRecord> {
  const dbRetry = resolveDbRetry(options);
  await withDbRetry(
    "worker.appendJobEvent.handler_failed",
    () => options.store.appendJobEvent(job.id, "handler_failed", failure.error, {
      retryable: failure.retryable,
      result: failure.result ?? null,
    }),
    dbRetry,
  );
  return withDbRetry(
    "worker.failJob",
    () => options.store.failJob(job.id, options.workerId, failure.error, {
      retryable: failure.retryable,
    }),
    dbRetry,
  );
}

async function runClaimedJob(
  options: JobWorkerOptions,
  job: JobRecord,
): Promise<JobWorkerOnceResult> {
  const logger = options.logger ?? consoleLogger;
  const handlers = { ...JOB_HANDLER_REGISTRY, ...(options.handlers ?? {}) };
  const heartbeat = startHeartbeat(options, job);
  const dbRetry = resolveDbRetry(options);

  try {
    let payload: JobPayload;
    try {
      payload = validateJobPayload(job.payload);
    } catch (err) {
      const finalJob = await failClaimedJob(options, job, {
        success: false,
        retryable: false,
        error: "invalid_payload",
        result: { message: err instanceof Error ? err.message : String(err) },
      });
      return { claimed: true, job, status: finalStatus(finalJob), finalJob };
    }

    const handler = handlers[payload.jobType];
    if (!handler) {
      const finalJob = await failClaimedJob(options, job, {
        success: false,
        retryable: false,
        error: "unregistered_job_type",
        result: { jobType: payload.jobType },
      });
      return { claimed: true, job, status: finalStatus(finalJob), finalJob };
    }

    await withDbRetry(
      "worker.appendJobEvent.handler_started",
      () => options.store.appendJobEvent(job.id, "handler_started", "Handler started", {
        workerId: options.workerId,
        jobType: payload.jobType,
      }),
      dbRetry,
    );

    let handlerResult;
    try {
      handlerResult = await handler(payload, {
        workerId: options.workerId,
        job,
        store: options.store,
        now: options.now ?? (() => new Date()),
        services: options.services ?? {},
        signal: heartbeat.signal,
      });
    } catch (err) {
      handlerResult = classifyThrownError(err);
    }

    const heartbeatError = heartbeat.getError();
    if (heartbeatError) {
      throw new Error(
        `heartbeat_failed: ${
          heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError)
        }`,
      );
    }

    if (!handlerResult.success) {
      const finalJob = await failClaimedJob(options, job, handlerResult);
      logger.warn("[jobs/worker] handler failed", { jobId: job.publicId, error: handlerResult.error });
      return { claimed: true, job, status: finalStatus(finalJob), finalJob };
    }

    await withDbRetry(
      "worker.appendJobEvent.handler_finished",
      () => options.store.appendJobEvent(job.id, "handler_finished", "Handler finished", {
        workerId: options.workerId,
        jobType: payload.jobType,
      }),
      dbRetry,
    );
    const finalJob = await withDbRetry(
      "worker.completeJob",
      () => options.store.completeJob(job.id, options.workerId, handlerResult.result),
      dbRetry,
    );
    logger.info("[jobs/worker] job completed", { jobId: job.publicId, jobType: payload.jobType });
    return { claimed: true, job, status: "succeeded", finalJob };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[jobs/worker] job execution error", { jobId: job.publicId, message });
    try {
      const finalJob = await failClaimedJob(options, job, {
        success: false,
        retryable: true,
        error: "worker_execution_error",
        result: { message },
      });
      return { claimed: true, job, status: finalStatus(finalJob), finalJob, error: message };
    } catch (failErr) {
      return {
        claimed: true,
        job,
        status: "error",
        error: failErr instanceof Error ? failErr.message : String(failErr),
      };
    }
  } finally {
    heartbeat.stop();
  }
}

export async function runJobWorkerOnce(options: JobWorkerOptions): Promise<JobWorkerOnceResult> {
  assertWorkerOptions(options);
  const logger = options.logger ?? consoleLogger;
  const dbRetry = resolveDbRetry(options);
  await withDbRetry(
    "worker.recoverExpiredJobs",
    () => options.store.recoverExpiredJobs(options.now?.() ?? new Date()),
    dbRetry,
  );
  const job = await withDbRetry(
    "worker.claimNextJob",
    () => options.store.claimNextJob(options.workerId, options.leaseMs),
    dbRetry,
  );
  if (!job) {
    logger.info("[jobs/worker] no queued job available");
    return { claimed: false, job: null, status: "no_job" };
  }
  return runClaimedJob(options, job);
}

export async function runJobWorkerLoop(options: JobWorkerOptions): Promise<void> {
  assertWorkerOptions(options);
  const logger = options.logger ?? consoleLogger;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const outageBackoffMs = resolveDbRetry(options).maxDelayMs;

  while (!options.signal?.aborted) {
    let result: JobWorkerOnceResult;
    try {
      // runJobWorkerOnce already retries recoverExpiredJobs/claimNextJob
      // internally (bounded, with backoff). If it still throws here, the DB
      // outage has outlasted those retries — back off and try the whole
      // loop iteration again instead of crashing the process. Only
      // transient DB-connectivity errors get this treatment; anything else
      // is a real bug and is left to propagate/crash as before.
      result = await runJobWorkerOnce(options);
    } catch (err) {
      if (!isTransientDbError(err)) throw err;
      logger.error("[jobs/worker] sustained DB outage — backing off before retrying the loop", {
        message: err instanceof Error ? err.message : String(err),
        backoffMs: outageBackoffMs,
      });
      await sleep(outageBackoffMs, options.signal).catch((sleepErr) => {
        if (!options.signal?.aborted) throw sleepErr;
      });
      continue;
    }
    if (!result.claimed) {
      await sleep(pollMs, options.signal).catch((err) => {
        if (!options.signal?.aborted) throw err;
      });
    }
  }
  logger.info("[jobs/worker] shutdown complete");
}
