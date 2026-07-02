import type { Pool, PoolClient } from "pg";
import { withPooledClient } from "@/lib/storage/clients";
import {
  type EnqueueJobOptions,
  type JobEventRecord,
  type JobIdentifier,
  type JobRecord,
  type JobRetryPolicy,
  type JobStatus,
  type JobStore,
  type ListJobsFilter,
  type RecoverExpiredJobsResult,
} from "./jobStore";
import { type JobPayload, type JobType, validateJobPayload } from "./types";

interface JobRow {
  id: number;
  public_id: string;
  job_type: string;
  status: JobStatus;
  priority: number;
  payload: JobPayload;
  result: unknown;
  dedupe_key: string | null;
  run_after: Date | string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: Date | string | null;
  lease_expires_at: Date | string | null;
  heartbeat_at: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  failed_at: Date | string | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface JobEventRow {
  id: number;
  job_id: number;
  event_type: string;
  message: string | null;
  metadata: unknown;
  created_at: Date | string;
}

const RETRY_BACKOFF_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000];

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    publicId: row.public_id,
    jobType: row.job_type as JobType,
    status: row.status,
    priority: row.priority,
    payload: row.payload,
    result: row.result,
    dedupeKey: row.dedupe_key,
    runAfter: iso(row.run_after),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lockedBy: row.locked_by,
    lockedAt: nullableIso(row.locked_at),
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    heartbeatAt: nullableIso(row.heartbeat_at),
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    failedAt: nullableIso(row.failed_at),
    error: row.error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowToEvent(row: JobEventRow): JobEventRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    eventType: row.event_type,
    message: row.message,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "23505";
}

function backoffMsForAttempt(attempts: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MS.length - 1)];
}

function normalizeJobIdentifier(jobId: JobIdentifier): string {
  return String(jobId);
}

function validateWorkerLease(workerId: string, leaseMs: number): void {
  if (workerId.trim().length === 0) throw new Error("workerId is required");
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be a positive finite number");
}

async function insertEvent(
  client: PoolClient,
  jobId: number,
  eventType: string,
  message: string | null,
  metadata: unknown,
): Promise<JobEventRecord> {
  const { rows } = await client.query<JobEventRow>(
    `insert into job_events (job_id, event_type, message, metadata)
     values ($1, $2, $3, $4::jsonb)
     returning *`,
    [jobId, eventType, message, JSON.stringify(metadata ?? {})],
  );
  return rowToEvent(rows[0]);
}

export class PostgresJobStore implements JobStore {
  constructor(private readonly pool: Pool) {}

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withPooledClient(this.pool, async (client) => {
      try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    });
  }

  async enqueueJob(payload: JobPayload, options: EnqueueJobOptions = {}): Promise<JobRecord> {
    const validPayload = validateJobPayload(payload);
    const priority = options.priority ?? 100;
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(priority) || priority < 0) throw new Error("priority must be a non-negative integer");
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new Error("maxAttempts must be a positive integer");

    return this.tx(async (client) => {
      await client.query("savepoint enqueue_insert");
      try {
        const { rows } = await client.query<JobRow>(
          `insert into jobs (job_type, status, priority, payload, dedupe_key, run_after, max_attempts)
           values ($1, 'queued', $2, $3::jsonb, $4, coalesce($5::timestamptz, now()), $6)
           returning *`,
          [
            validPayload.jobType,
            priority,
            JSON.stringify(validPayload),
            options.dedupeKey ?? null,
            options.runAfter ? iso(options.runAfter) : null,
            maxAttempts,
          ],
        );
        const job = rowToJob(rows[0]);
        await insertEvent(client, job.id, "job_enqueued", "Job queued", {
          dedupeKey: job.dedupeKey,
          priority: job.priority,
          runAfter: job.runAfter,
        });
        return job;
      } catch (err) {
        if (!isUniqueViolation(err) || !options.dedupeKey) throw err;
        await client.query("rollback to savepoint enqueue_insert");
        const { rows } = await client.query<JobRow>(
          `select * from jobs
           where job_type = $1
             and dedupe_key = $2
             and status in ('queued', 'running')
           order by id asc
           for update
           limit 1`,
          [validPayload.jobType, options.dedupeKey],
        );
        if (!rows[0]) throw err;
        const job = rowToJob(rows[0]);
        await insertEvent(client, job.id, "job_deduped", "Active duplicate job reused", {
          dedupeKey: options.dedupeKey,
        });
        return job;
      }
    });
  }

  async fetchJob(publicId: string): Promise<JobRecord | null> {
    const { rows } = await this.pool.query<JobRow>(
      `select * from jobs where public_id::text = $1 limit 1`,
      [publicId],
    );
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async listJobs(filter: ListJobsFilter = {}): Promise<JobRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };
    if (filter.jobType) add("job_type = ?", filter.jobType);
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      add("status = any(?::text[])", statuses);
    }
    const limit = filter.limit ?? 50;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 500) throw new Error("limit must be an integer between 1 and 500");
    values.push(limit);
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const { rows } = await this.pool.query<JobRow>(
      `select * from jobs ${where} order by created_at desc, id desc limit $${values.length}`,
      values,
    );
    return rows.map(rowToJob);
  }

  async claimNextJob(workerId: string, leaseMs: number): Promise<JobRecord | null> {
    validateWorkerLease(workerId, leaseMs);
    return this.tx(async (client) => {
      const claimable = await client.query<JobRow>(
        `select *
         from jobs
         where status = 'queued'
           and run_after <= now()
         order by priority asc, run_after asc, id asc
         for update skip locked
         limit 1`,
      );
      const row = claimable.rows[0];
      if (!row) return null;

      const { rows } = await client.query<JobRow>(
        `update jobs
         set status = 'running',
             locked_by = $2,
             locked_at = now(),
             lease_expires_at = now() + ($3::double precision * interval '1 millisecond'),
             heartbeat_at = now(),
             started_at = coalesce(started_at, now()),
             completed_at = null,
             failed_at = null,
             error = null,
             attempts = attempts + 1
         where id = $1
         returning *`,
        [row.id, workerId, leaseMs],
      );
      const job = rowToJob(rows[0]);
      await insertEvent(client, job.id, "job_claimed", "Job claimed by worker", {
        workerId,
        leaseMs,
        attempts: job.attempts,
      });
      return job;
    });
  }

  async recoverExpiredJobs(now: string | Date = new Date()): Promise<RecoverExpiredJobsResult> {
    const recoveryNow = iso(now);
    return this.tx(async (client) => {
      const expired = await client.query<JobRow>(
        `select *
         from jobs
         where status = 'running'
           and lease_expires_at is not null
           and lease_expires_at < $1::timestamptz
         order by lease_expires_at asc, id asc
         for update skip locked`,
        [recoveryNow],
      );

      const requeued: JobRecord[] = [];
      const dead: JobRecord[] = [];
      for (const row of expired.rows) {
        if (row.attempts < row.max_attempts) {
          const backoffMs = backoffMsForAttempt(row.attempts);
          const runAfter = new Date(Date.parse(recoveryNow) + backoffMs).toISOString();
          const { rows } = await client.query<JobRow>(
            `update jobs
             set status = 'queued',
                 locked_by = null,
                 locked_at = null,
                 lease_expires_at = null,
                 heartbeat_at = null,
                 run_after = $2::timestamptz,
                 error = coalesce(error, 'worker lease expired')
             where id = $1
             returning *`,
            [row.id, runAfter],
          );
          const job = rowToJob(rows[0]);
          await insertEvent(client, job.id, "lease_expired_requeued", "Expired worker lease recovered to queued", {
            previousWorkerId: row.locked_by,
            backoffMs,
            runAfter,
          });
          requeued.push(job);
        } else {
          const { rows } = await client.query<JobRow>(
            `update jobs
             set status = 'dead',
                 locked_by = null,
                 locked_at = null,
                 lease_expires_at = null,
                 heartbeat_at = null,
                 failed_at = $2::timestamptz,
                 error = coalesce(error, 'worker lease expired; max attempts reached')
             where id = $1
             returning *`,
            [row.id, recoveryNow],
          );
          const job = rowToJob(rows[0]);
          await insertEvent(client, job.id, "lease_expired_dead", "Expired worker lease exhausted attempts", {
            previousWorkerId: row.locked_by,
          });
          dead.push(job);
        }
      }
      return { requeued, dead };
    });
  }

  async heartbeatJob(jobId: JobIdentifier, workerId: string, leaseMs: number): Promise<JobRecord> {
    validateWorkerLease(workerId, leaseMs);
    return this.tx(async (client) => {
      const { rows } = await client.query<JobRow>(
        `update jobs
         set heartbeat_at = now(),
             lease_expires_at = now() + ($3::double precision * interval '1 millisecond')
         where (public_id::text = $1 or id::text = $1)
           and status = 'running'
           and locked_by = $2
           and lease_expires_at > now()
         returning *`,
        [normalizeJobIdentifier(jobId), workerId, leaseMs],
      );
      if (!rows[0]) throw new Error(`running job with active lease not found for heartbeat: ${jobId}`);
      const job = rowToJob(rows[0]);
      await insertEvent(client, job.id, "job_heartbeat", "Worker heartbeat extended lease", { workerId, leaseMs });
      return job;
    });
  }

  async completeJob(jobId: JobIdentifier, workerId: string, result: unknown): Promise<JobRecord> {
    if (workerId.trim().length === 0) throw new Error("workerId is required");
    return this.tx(async (client) => {
      const { rows } = await client.query<JobRow>(
        `update jobs
         set status = 'succeeded',
             result = $3::jsonb,
             locked_by = null,
             locked_at = null,
             lease_expires_at = null,
             heartbeat_at = null,
             completed_at = now(),
             failed_at = null,
             error = null
         where (public_id::text = $1 or id::text = $1)
           and status = 'running'
           and locked_by = $2
           and lease_expires_at > now()
         returning *`,
        [normalizeJobIdentifier(jobId), workerId, JSON.stringify(result ?? {})],
      );
      if (!rows[0]) throw new Error(`running job with active lease not found for completion: ${jobId}`);
      const job = rowToJob(rows[0]);
      await insertEvent(client, job.id, "job_succeeded", "Job completed successfully", { workerId });
      return job;
    });
  }

  async failJob(jobId: JobIdentifier, workerId: string, error: string, retryPolicy: JobRetryPolicy): Promise<JobRecord> {
    if (workerId.trim().length === 0) throw new Error("workerId is required");
    if (error.trim().length === 0) throw new Error("error is required");
    return this.tx(async (client) => {
      const current = await client.query<JobRow>(
        `select * from jobs
         where (public_id::text = $1 or id::text = $1)
           and status = 'running'
           and locked_by = $2
           and lease_expires_at > now()
         for update
         limit 1`,
        [normalizeJobIdentifier(jobId), workerId],
      );
      const row = current.rows[0];
      if (!row) throw new Error(`running job with active lease not found for failure: ${jobId}`);

      if (!retryPolicy.retryable) {
        const { rows } = await client.query<JobRow>(
          `update jobs
           set status = 'failed',
               locked_by = null,
               locked_at = null,
               lease_expires_at = null,
               heartbeat_at = null,
               failed_at = now(),
               error = $2
           where id = $1
           returning *`,
          [row.id, error],
        );
        const job = rowToJob(rows[0]);
        await insertEvent(client, job.id, "job_failed", "Job failed without retry", { workerId, retryable: false, error });
        return job;
      }

      if (row.attempts >= row.max_attempts) {
        const { rows } = await client.query<JobRow>(
          `update jobs
           set status = 'dead',
               locked_by = null,
               locked_at = null,
               lease_expires_at = null,
               heartbeat_at = null,
               failed_at = now(),
               error = $2
           where id = $1
           returning *`,
          [row.id, error],
        );
        const job = rowToJob(rows[0]);
        await insertEvent(client, job.id, "job_dead", "Retryable job exhausted attempts", {
          workerId,
          retryable: true,
          error,
        });
        return job;
      }

      const backoffMs = retryPolicy.backoffMs ?? backoffMsForAttempt(row.attempts);
      if (!Number.isFinite(backoffMs) || backoffMs < 0) throw new Error("backoffMs must be non-negative when provided");
      const runAfter = new Date(Date.now() + backoffMs).toISOString();
      const { rows } = await client.query<JobRow>(
        `update jobs
         set status = 'queued',
             locked_by = null,
             locked_at = null,
             lease_expires_at = null,
             heartbeat_at = null,
             run_after = $3::timestamptz,
             error = $2
         where id = $1
         returning *`,
        [row.id, error, runAfter],
      );
      const job = rowToJob(rows[0]);
      await insertEvent(client, job.id, "job_failed", "Retryable job requeued after failure", {
        workerId,
        retryable: true,
        error,
        backoffMs,
        runAfter,
      });
      return job;
    });
  }

  async cancelJob(jobId: JobIdentifier, reason: string): Promise<JobRecord> {
    if (reason.trim().length === 0) throw new Error("cancel reason is required");
    return this.tx(async (client) => {
      const { rows } = await client.query<JobRow>(
        `update jobs
         set status = 'cancelled',
             locked_by = null,
             locked_at = null,
             lease_expires_at = null,
             heartbeat_at = null,
             completed_at = now(),
             error = $2
         where (public_id::text = $1 or id::text = $1)
           and status in ('queued', 'running')
         returning *`,
        [normalizeJobIdentifier(jobId), reason],
      );
      if (!rows[0]) throw new Error(`queued/running job not found for cancellation: ${jobId}`);
      const job = rowToJob(rows[0]);
      await insertEvent(client, job.id, "job_cancelled", "Job cancelled", { reason });
      return job;
    });
  }

  async appendJobEvent(
    jobId: JobIdentifier,
    eventType: string,
    message: string | null = null,
    metadata: unknown = {},
  ): Promise<JobEventRecord> {
    if (eventType.trim().length === 0) throw new Error("eventType is required");
    return this.tx(async (client) => {
      const { rows } = await client.query<{ id: number }>(
        `select id from jobs where public_id::text = $1 or id::text = $1 limit 1`,
        [normalizeJobIdentifier(jobId)],
      );
      if (!rows[0]) throw new Error(`job not found for event append: ${jobId}`);
      return insertEvent(client, rows[0].id, eventType, message, metadata);
    });
  }
}
