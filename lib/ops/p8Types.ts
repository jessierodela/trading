export const P8_PIPELINE_STAGES = [
  "market.ingest.latest",
  "features.compute",
  "regime.compute",
  "strategies.evaluate",
  "paper.monitor",
  "dashboard.snapshot",
] as const;

export type P8PipelineStageName = (typeof P8_PIPELINE_STAGES)[number];

export type P8JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "dead";

export type P8StageStatus = P8JobStatus | "missing";

export interface RecentJobSummary {
  publicId: string;
  jobType: string;
  status: P8JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  resultSummary: string | null;
  error: string | null;
}

export interface ScheduledStageSummary {
  stage: P8PipelineStageName;
  status: P8StageStatus;
  publicId: string | null;
  attempts: number;
  maxAttempts: number;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  durationMs: number | null;
  resultSummary: string | null;
  error: string | null;
  runAfter: string | null;
  createdAt: string | null;
}

export interface P8OpsSummary {
  generatedAt: string;

  scheduler: {
    routePath: "/api/jobs/schedule";
    cronExpression: "5 * * * *";
    cronMeaning: string;
    schedulerSecretPresent: boolean;
    externalSchedulerVerified: "yes" | "no" | "unknown";
    lastScheduledFeed: {
      closedBarTs: string | null;
      enqueuedAt: string | null;
      stages: ScheduledStageSummary[];
    } | null;
  };

  queue: {
    /** succeeded, failed, and dead are windowed to recentWindowHours; queued/running are live states. */
    counts: Record<P8JobStatus, number>;
    /** All-time dead job count, including historical incidents outside the window. */
    deadTotal: number;
    recentWindowHours: number;
    oldestQueuedAgeSeconds: number | null;
    expiredLeaseCount: number;
    latestJobEventAt: string | null;
    recentJobs: RecentJobSummary[];
  };

  worker: {
    status: "active" | "recently_active" | "idle" | "attention" | "unknown";
    lastClaimedJob: RecentJobSummary | null;
    lastCompletedJob: RecentJobSummary | null;
    lastHeartbeatOrLeaseAt: string | null;
    recommendation: string;
  };

  pipeline: {
    stages: ScheduledStageSummary[];
  };

  snapshot: {
    signalsSource: "dashboard_snapshots" | "memCache" | "empty" | "unknown";
    latestDashboardSnapshot: {
      publicId: string;
      generatedAt: string;
      expiresAt: string | null;
      isExpired: boolean;
      sourceJobPublicId: string | null;
      payloadSummary: {
        agentResultsCount: number;
        activityCount: number;
        confluenceCount: number;
        symbols: string[];
      };
    } | null;
  };

  regime: {
    symbols: Array<{
      symbol: string;
      regime: string | null;
      reliability: number | null;
      timestamp: string | null;
      source: "regime_snapshots" | "dashboard_snapshots" | "memCache" | "empty" | "unknown";
      stale: boolean;
    }>;
  };

  readiness: Array<{
    label: string;
    status: "pass" | "partial" | "not_configured" | "unknown";
    detail: string;
  }>;
}
