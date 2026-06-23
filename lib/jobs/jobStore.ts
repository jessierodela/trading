import type { JobPayload, JobType } from "./types";

export type JobStatus =
  // queued: waiting to be claimed.
  | "queued"
  // running: claimed by a worker with an active lease.
  | "running"
  // succeeded: terminal success.
  | "succeeded"
  // failed: terminal non-retryable failure.
  | "failed"
  // cancelled: terminal manual/system cancellation.
  | "cancelled"
  // dead: terminal retry-exhausted failure.
  | "dead";

export interface JobRecord {
  id: number;
  publicId: string;
  jobType: JobType;
  status: JobStatus;
  priority: number;
  payload: JobPayload;
  result: unknown;
  dedupeKey: string | null;
  runAfter: string;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobEventRecord {
  id: number;
  jobId: number;
  eventType: string;
  message: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface EnqueueJobOptions {
  priority?: number;
  dedupeKey?: string;
  runAfter?: string | Date;
  maxAttempts?: number;
}

export interface ListJobsFilter {
  status?: JobStatus | JobStatus[];
  jobType?: JobType;
  limit?: number;
}

export interface JobRetryPolicy {
  retryable: boolean;
  backoffMs?: number;
}

export interface RecoverExpiredJobsResult {
  requeued: JobRecord[];
  dead: JobRecord[];
}

export type JobIdentifier = string | number;

export interface JobStore {
  enqueueJob(payload: JobPayload, options?: EnqueueJobOptions): Promise<JobRecord>;
  fetchJob(publicId: string): Promise<JobRecord | null>;
  listJobs(filter?: ListJobsFilter): Promise<JobRecord[]>;
  claimNextJob(workerId: string, leaseMs: number): Promise<JobRecord | null>;
  recoverExpiredJobs(now?: string | Date): Promise<RecoverExpiredJobsResult>;
  heartbeatJob(jobId: JobIdentifier, workerId: string, leaseMs: number): Promise<JobRecord>;
  completeJob(jobId: JobIdentifier, workerId: string, result: unknown): Promise<JobRecord>;
  failJob(jobId: JobIdentifier, workerId: string, error: string, retryPolicy: JobRetryPolicy): Promise<JobRecord>;
  cancelJob(jobId: JobIdentifier, reason: string): Promise<JobRecord>;
  appendJobEvent(jobId: JobIdentifier, eventType: string, message?: string | null, metadata?: unknown): Promise<JobEventRecord>;
}
