import type { JobRecord, JobStatus } from "./jobStore";

export const PRESENTED_JOB_STATUSES: JobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "dead",
  "cancelled",
];

export interface PresentedJob {
  id: string;
  jobType: string;
  status: JobStatus;
  runAfter: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
}

export function isPresentedJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && PRESENTED_JOB_STATUSES.includes(value as JobStatus);
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "dead" || status === "cancelled";
}

export function presentJob(job: JobRecord): PresentedJob {
  return {
    id: job.publicId,
    jobType: job.jobType,
    status: job.status,
    runAfter: job.runAfter,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.error,
    result: job.result,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
  };
}

export function presentJobs(jobs: JobRecord[]): PresentedJob[] {
  return jobs.map(presentJob);
}
