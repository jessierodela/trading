import type { Pool } from "pg";
import {
  P8_PIPELINE_STAGES,
  type P8JobStatus,
  type P8OpsSummary,
  type P8PipelineStageName,
  type RecentJobSummary,
  type ScheduledStageSummary,
} from "./p8Types";

export const P8_TRACKED_SYMBOLS = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "LINK-USD",
  "AVAX-USD",
] as const;

const RECENT_WINDOW_HOURS = 24;
const WORKER_RECENT_MS = 15 * 60_000;
const WORKER_HEARTBEAT_RECENT_MS = 2 * 60_000;
const REGIME_FRESH_MS = 2 * 60 * 60_000;

const STAGE_OFFSETS_MINUTES: Record<P8PipelineStageName, number> = {
  "market.ingest.latest": 5,
  "features.compute": 7,
  "regime.compute": 9,
  "strategies.evaluate": 11,
  "paper.monitor": 13,
  "dashboard.snapshot": 15,
};

export interface P8OpsJobRow {
  public_id: string;
  job_type: string;
  status: P8JobStatus;
  priority: number;
  result: unknown;
  dedupe_key: string | null;
  run_after: Date | string;
  attempts: number;
  max_attempts: number;
  lease_expires_at: Date | string | null;
  heartbeat_at: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  failed_at: Date | string | null;
  error: string | null;
  created_at: Date | string;
}

export interface P8OpsSnapshotRow {
  public_id: string;
  payload: unknown;
  generated_at: Date | string;
  expires_at: Date | string | null;
  source_job_public_id: string | null;
}

export interface P8OpsRegimeRow {
  symbol: string;
  regime: string;
  reliability: number | string | null;
  ts: Date | string;
}

export interface P8OpsBuildInput {
  now?: Date;
  schedulerSecretPresent?: boolean;
  jobs?: P8OpsJobRow[];
  counts?: Partial<Record<P8JobStatus, number>>;
  /** All-time dead job count; counts.dead is windowed to the recent window. */
  deadTotal?: number;
  oldestQueuedAgeSeconds?: number | null;
  expiredLeaseCount?: number;
  latestJobEventAt?: Date | string | null;
  snapshot?: P8OpsSnapshotRow | null;
  regimes?: P8OpsRegimeRow[];
  memoryResponse?: object | null;
  memoryExpiresAt?: number;
}

interface QueueMetricsRow {
  queued: number | string;
  running: number | string;
  succeeded: number | string;
  failed: number | string;
  cancelled: number | string;
  dead: number | string;
  dead_total: number | string;
  oldest_queued_age_seconds: number | string | null;
  expired_lease_count: number | string;
}

interface LatestEventRow {
  created_at: Date | string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function compactValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export function summarizeJobResult(result: unknown): string | null {
  const record = asRecord(result);
  if (!record || Object.keys(record).length === 0) return null;

  const preferredKeys = [
    "message",
    "reason",
    "code",
    "snapshotPublicId",
    "barsInserted",
    "featuresComputed",
    "regimesComputed",
    "signalsCreated",
    "positionsMonitored",
    "agentCount",
    "confluenceCount",
    "durationMs",
  ];
  const parts: string[] = [];
  for (const key of preferredKeys) {
    const value = compactValue(record[key]);
    if (value !== null) parts.push(`${key}: ${value}`);
  }

  if (parts.length === 0) {
    for (const [key, raw] of Object.entries(record)) {
      const value = compactValue(raw);
      if (value !== null) parts.push(`${key}: ${value}`);
    }
  }

  const summary = parts.slice(0, 3).join(" | ");
  return summary.length > 180 ? `${summary.slice(0, 177)}...` : summary || "Result recorded";
}

export function toRecentJobSummary(row: P8OpsJobRow): RecentJobSummary {
  return {
    publicId: row.public_id,
    jobType: row.job_type,
    status: row.status,
    priority: numeric(row.priority),
    attempts: numeric(row.attempts),
    maxAttempts: numeric(row.max_attempts),
    runAfter: iso(row.run_after),
    createdAt: iso(row.created_at),
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    failedAt: nullableIso(row.failed_at),
    heartbeatAt: nullableIso(row.heartbeat_at),
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    resultSummary: summarizeJobResult(row.result),
    error: row.error,
  };
}

function missingStage(stage: P8PipelineStageName): ScheduledStageSummary {
  return {
    stage,
    status: "missing",
    publicId: null,
    attempts: 0,
    maxAttempts: 0,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    durationMs: null,
    resultSummary: null,
    error: null,
    runAfter: null,
    createdAt: null,
  };
}

function toStageSummary(stage: P8PipelineStageName, row: P8OpsJobRow | undefined): ScheduledStageSummary {
  if (!row) return missingStage(stage);
  const startedAt = nullableIso(row.started_at);
  const endedAt = nullableIso(row.completed_at ?? row.failed_at);
  return {
    stage,
    status: row.status,
    publicId: row.public_id,
    attempts: numeric(row.attempts),
    maxAttempts: numeric(row.max_attempts),
    startedAt,
    completedAt: nullableIso(row.completed_at),
    failedAt: nullableIso(row.failed_at),
    durationMs: durationMs(startedAt, endedAt),
    resultSummary: summarizeJobResult(row.result),
    error: row.error,
    runAfter: iso(row.run_after),
    createdAt: iso(row.created_at),
  };
}

function latestRowsByStage(rows: P8OpsJobRow[]): ScheduledStageSummary[] {
  return P8_PIPELINE_STAGES.map((stage) =>
    toStageSummary(stage, rows.find((row) => row.job_type === stage)),
  );
}

function scheduledClosedBarMs(row: P8OpsJobRow): number | null {
  if (!row.dedupe_key?.startsWith("scheduled:")) return null;
  if (!P8_PIPELINE_STAGES.includes(row.job_type as P8PipelineStageName)) return null;
  const runAfterMs = Date.parse(iso(row.run_after));
  const offsetMs = STAGE_OFFSETS_MINUTES[row.job_type as P8PipelineStageName] * 60_000;
  return Number.isFinite(runAfterMs) ? runAfterMs - offsetMs : null;
}

function latestScheduledFeed(rows: P8OpsJobRow[]): P8OpsSummary["scheduler"]["lastScheduledFeed"] {
  const scheduledRows = rows
    .map((row) => ({ row, closedBarMs: scheduledClosedBarMs(row) }))
    .filter((entry): entry is { row: P8OpsJobRow; closedBarMs: number } => entry.closedBarMs !== null);
  if (scheduledRows.length === 0) return null;

  const closedBarMs = Math.max(...scheduledRows.map((entry) => entry.closedBarMs));
  const feedRows = scheduledRows
    .filter((entry) => entry.closedBarMs === closedBarMs)
    .map((entry) => entry.row);
  const enqueuedAtMs = Math.max(...feedRows.map((row) => Date.parse(iso(row.created_at))));

  return {
    closedBarTs: new Date(closedBarMs).toISOString(),
    enqueuedAt: new Date(enqueuedAtMs).toISOString(),
    stages: latestRowsByStage(feedRows),
  };
}

function newestBy(rows: RecentJobSummary[], field: "startedAt" | "completedAt"): RecentJobSummary | null {
  return rows
    .filter((row) => row[field] !== null)
    .sort((a, b) => Date.parse(b[field] as string) - Date.parse(a[field] as string))[0] ?? null;
}

export function deriveWorkerStatus(input: {
  now: Date;
  jobs: RecentJobSummary[];
  queuedCount: number;
  runningCount: number;
}): P8OpsSummary["worker"] {
  const nowMs = input.now.getTime();
  const running = input.jobs.filter((job) => job.status === "running");
  const hasRecentLease = running.some((job) => {
    const heartbeatMs = job.heartbeatAt ? Date.parse(job.heartbeatAt) : Number.NEGATIVE_INFINITY;
    const leaseMs = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : Number.NEGATIVE_INFINITY;
    return heartbeatMs >= nowMs - WORKER_HEARTBEAT_RECENT_MS && leaseMs > nowMs;
  });
  const lastCompletedJob = newestBy(
    input.jobs.filter((job) => job.status === "succeeded"),
    "completedAt",
  );
  const completedRecently = !!lastCompletedJob?.completedAt
    && Date.parse(lastCompletedJob.completedAt) >= nowMs - WORKER_RECENT_MS;

  let status: P8OpsSummary["worker"]["status"] = "unknown";
  if (hasRecentLease) status = "active";
  else if (completedRecently) status = "recently_active";
  else if (input.queuedCount === 0 && input.runningCount === 0) status = "idle";
  else if (input.queuedCount > 0 || input.runningCount > 0) status = "attention";

  const activityTimes = input.jobs.flatMap((job) => [job.heartbeatAt, job.leaseExpiresAt])
    .filter((value): value is string => value !== null)
    .sort((a, b) => Date.parse(b) - Date.parse(a));

  return {
    status,
    lastClaimedJob: newestBy(input.jobs, "startedAt"),
    lastCompletedJob,
    lastHeartbeatOrLeaseAt: activityTimes[0] ?? null,
    recommendation: "npm.cmd run worker:jobs -- --loop --poll-ms 5000 --lease-ms 60000",
  };
}

function snapshotSymbols(payload: Record<string, unknown>): string[] {
  const symbols = new Set<string>();
  for (const key of Object.keys(asRecord(payload.regimeMap) ?? {})) symbols.add(key);
  for (const key of Object.keys(asRecord(payload.indicators) ?? {})) symbols.add(key);
  for (const result of asArray(payload.agentResults)) {
    const signals = asArray(asRecord(result)?.signals);
    for (const signal of signals) {
      const symbol = asRecord(signal)?.symbol;
      if (typeof symbol === "string") symbols.add(symbol);
    }
  }
  for (const item of asArray(payload.confluence)) {
    const symbol = asRecord(item)?.symbol;
    if (typeof symbol === "string") symbols.add(symbol);
  }
  return [...symbols].sort();
}

function summarizeSnapshot(
  row: P8OpsSnapshotRow | null,
  nowMs: number,
): P8OpsSummary["snapshot"]["latestDashboardSnapshot"] {
  if (!row) return null;
  const payload = asRecord(row.payload) ?? {};
  const expiresAt = nullableIso(row.expires_at);
  return {
    publicId: row.public_id,
    generatedAt: iso(row.generated_at),
    expiresAt,
    isExpired: expiresAt !== null && Date.parse(expiresAt) <= nowMs,
    sourceJobPublicId: row.source_job_public_id,
    payloadSummary: {
      agentResultsCount: asArray(payload.agentResults).length,
      activityCount: asArray(payload.activity).length,
      confluenceCount: asArray(payload.confluence).length,
      symbols: snapshotSymbols(payload),
    },
  };
}

function deriveRegimes(input: {
  nowMs: number;
  rows: P8OpsRegimeRow[];
  snapshot: P8OpsSnapshotRow | null;
  memoryResponse: object | null;
}): P8OpsSummary["regime"]["symbols"] {
  const persisted = new Map(input.rows.map((row) => [row.symbol.toUpperCase(), row]));
  const snapshotPayload = asRecord(input.snapshot?.payload);
  const snapshotRegimes = asRecord(snapshotPayload?.regimeMap);
  const memoryPayload = asRecord(input.memoryResponse);
  const memoryRegimes = asRecord(memoryPayload?.regimeMap);

  return P8_TRACKED_SYMBOLS.map((symbol) => {
    const persistedRow = persisted.get(symbol);
    if (persistedRow) {
      const timestamp = iso(persistedRow.ts);
      return {
        symbol,
        regime: persistedRow.regime,
        reliability: persistedRow.reliability === null ? null : numeric(persistedRow.reliability),
        timestamp,
        source: "regime_snapshots" as const,
        stale: input.nowMs - Date.parse(timestamp) > REGIME_FRESH_MS,
      };
    }

    const snapshotRegime = asRecord(snapshotRegimes?.[symbol]);
    if (snapshotRegime) {
      const timestamp = input.snapshot ? iso(input.snapshot.generated_at) : null;
      return {
        symbol,
        regime: typeof snapshotRegime.regime === "string" ? snapshotRegime.regime : null,
        reliability: snapshotRegime.reliability === undefined ? null : numeric(snapshotRegime.reliability as number),
        timestamp,
        source: "dashboard_snapshots" as const,
        stale: timestamp === null || input.nowMs - Date.parse(timestamp) > REGIME_FRESH_MS,
      };
    }

    const memoryRegime = asRecord(memoryRegimes?.[symbol]);
    if (memoryRegime) {
      const timestamp = typeof memoryPayload?.generatedAt === "string" ? memoryPayload.generatedAt : null;
      return {
        symbol,
        regime: typeof memoryRegime.regime === "string" ? memoryRegime.regime : null,
        reliability: memoryRegime.reliability === undefined ? null : numeric(memoryRegime.reliability as number),
        timestamp,
        source: "memCache" as const,
        stale: timestamp === null || input.nowMs - Date.parse(timestamp) > REGIME_FRESH_MS,
      };
    }

    return {
      symbol,
      regime: null,
      reliability: null,
      timestamp: null,
      source: "empty" as const,
      stale: true,
    };
  });
}

function readiness(input: {
  schedulerSecretPresent: boolean;
  lastScheduledFeed: P8OpsSummary["scheduler"]["lastScheduledFeed"];
  worker: P8OpsSummary["worker"];
  snapshot: P8OpsSummary["snapshot"]["latestDashboardSnapshot"];
  signalsSource: P8OpsSummary["snapshot"]["signalsSource"];
}): P8OpsSummary["readiness"] {
  return [
    {
      label: "P8 branch merged to main",
      status: "unknown",
      detail: "Runtime data cannot determine Git branch state.",
    },
    {
      label: "Deployment contains scheduler route",
      status: "pass",
      detail: "This summary is served alongside /api/jobs/schedule.",
    },
    {
      label: "External Linux scheduler runs hourly",
      status: input.lastScheduledFeed ? "partial" : "unknown",
      detail: "The minute-five cadence is documented; systemd origin is not persisted with jobs.",
    },
    {
      label: "Scheduler authorization configured",
      status: input.schedulerSecretPresent ? "pass" : "not_configured",
      detail: input.schedulerSecretPresent
        ? "SCHEDULER_SECRET is present."
        : "Set the same SCHEDULER_SECRET in Vercel and on the Linux scheduler host.",
    },
    {
      label: "First real scheduled feed verified",
      status: input.lastScheduledFeed ? "partial" : "unknown",
      detail: input.lastScheduledFeed
        ? "Scheduled jobs exist, but their systemd or CLI origin is not recorded."
        : "No persisted scheduled feed is visible.",
    },
    {
      label: "Worker host configured",
      status: input.worker.status === "active" || input.worker.status === "recently_active" ? "partial" : "unknown",
      detail: "Job activity can be inferred; hosting configuration cannot be read here.",
    },
    {
      label: "Worker loop supervised",
      status: "unknown",
      detail: "Supervisor state is external to the jobs database.",
    },
    {
      label: "Dashboard snapshot generated by worker",
      status: input.snapshot?.sourceJobPublicId ? "pass" : input.snapshot ? "partial" : "unknown",
      detail: input.snapshot?.sourceJobPublicId
        ? "The latest snapshot is linked to a public job ID."
        : "No worker-linked dashboard snapshot is visible.",
    },
    {
      label: "/api/signals serving persisted state",
      status: input.signalsSource === "dashboard_snapshots" ? "pass" : input.signalsSource === "memCache" ? "partial" : "unknown",
      detail: `Current inferred source: ${input.signalsSource}.`,
    },
    {
      label: "No live execution enabled",
      status: "pass",
      detail: "P8 exposes monitoring and paper-only pipeline job types.",
    },
  ];
}

export function buildP8OpsSummary(input: P8OpsBuildInput = {}): P8OpsSummary {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const rows = input.jobs ?? [];
  const recentJobs = rows.map(toRecentJobSummary);
  const counts: Record<P8JobStatus, number> = {
    queued: numeric(input.counts?.queued),
    running: numeric(input.counts?.running),
    succeeded: numeric(input.counts?.succeeded),
    failed: numeric(input.counts?.failed),
    cancelled: numeric(input.counts?.cancelled),
    dead: numeric(input.counts?.dead),
  };
  const worker = deriveWorkerStatus({
    now,
    jobs: recentJobs,
    queuedCount: counts.queued,
    runningCount: counts.running,
  });
  const latestDashboardSnapshot = summarizeSnapshot(input.snapshot ?? null, nowMs);
  const memoryFresh = !!input.memoryResponse
    && input.memoryExpiresAt !== undefined
    && input.memoryExpiresAt > nowMs;
  const signalsSource: P8OpsSummary["snapshot"]["signalsSource"] = latestDashboardSnapshot
    && !latestDashboardSnapshot.isExpired
    ? "dashboard_snapshots"
    : memoryFresh
      ? "memCache"
      : "empty";
  const lastScheduledFeed = latestScheduledFeed(rows);

  return {
    generatedAt: now.toISOString(),
    scheduler: {
      routePath: "/api/jobs/schedule",
      cronExpression: "5 * * * *",
      cronMeaning: "Every hour at minute 5",
      schedulerSecretPresent: input.schedulerSecretPresent === true,
      externalSchedulerVerified: "unknown",
      lastScheduledFeed,
    },
    queue: {
      counts,
      deadTotal: Math.max(numeric(input.deadTotal), counts.dead),
      recentWindowHours: RECENT_WINDOW_HOURS,
      oldestQueuedAgeSeconds: input.oldestQueuedAgeSeconds ?? null,
      expiredLeaseCount: numeric(input.expiredLeaseCount),
      latestJobEventAt: input.latestJobEventAt ? iso(input.latestJobEventAt) : null,
      recentJobs: recentJobs.slice(0, 20),
    },
    worker,
    pipeline: {
      stages: latestRowsByStage(rows),
    },
    snapshot: {
      signalsSource,
      latestDashboardSnapshot,
    },
    regime: {
      symbols: deriveRegimes({
        nowMs,
        rows: input.regimes ?? [],
        snapshot: input.snapshot ?? null,
        memoryResponse: input.memoryResponse ?? null,
      }),
    },
    readiness: readiness({
      schedulerSecretPresent: input.schedulerSecretPresent === true,
      lastScheduledFeed,
      worker,
      snapshot: latestDashboardSnapshot,
      signalsSource,
    }),
  };
}

export async function loadP8OpsSummary(input: {
  pool: Pool;
  env?: NodeJS.ProcessEnv;
  memoryResponse?: object | null;
  memoryExpiresAt?: number;
  now?: Date;
}): Promise<P8OpsSummary> {
  const jobsQuery = input.pool.query<P8OpsJobRow>(
    `select public_id::text, job_type, status, priority, result, dedupe_key,
            run_after, attempts, max_attempts, lease_expires_at, heartbeat_at,
            started_at, completed_at, failed_at, error, created_at
     from jobs
     order by created_at desc, id desc
     limit 80`,
  );
  const metricsQuery = input.pool.query<QueueMetricsRow>(
    `select
       count(*) filter (where status = 'queued')::int as queued,
       count(*) filter (where status = 'running')::int as running,
       count(*) filter (
         where status = 'succeeded'
           and completed_at >= now() - interval '24 hours'
       )::int as succeeded,
       count(*) filter (
         where status = 'failed'
           and failed_at >= now() - interval '24 hours'
       )::int as failed,
       count(*) filter (where status = 'cancelled')::int as cancelled,
       count(*) filter (
         where status = 'dead'
           and failed_at >= now() - interval '24 hours'
       )::int as dead,
       count(*) filter (where status = 'dead')::int as dead_total,
       extract(epoch from (now() - min(created_at) filter (where status = 'queued')))
         as oldest_queued_age_seconds,
       count(*) filter (
         where status = 'running'
           and lease_expires_at is not null
           and lease_expires_at <= now()
       )::int as expired_lease_count
     from jobs`,
  );
  const eventQuery = input.pool.query<LatestEventRow>(
    `select created_at
     from job_events
     order by created_at desc, id desc
     limit 1`,
  );
  const snapshotQuery = input.pool.query<P8OpsSnapshotRow>(
    `select ds.public_id::text, ds.payload, ds.generated_at, ds.expires_at,
            j.public_id::text as source_job_public_id
     from dashboard_snapshots ds
     left join jobs j on j.id = ds.source_job_id
     where ds.snapshot_type = 'dashboard'
     order by ds.generated_at desc, ds.id desc
     limit 1`,
  );
  const regimeQuery = input.pool.query<P8OpsRegimeRow>(
    `select distinct on (symbol) symbol, regime, reliability, ts
     from regime_snapshots
     where symbol = any($1::text[])
     order by symbol, ts desc`,
    [[...P8_TRACKED_SYMBOLS]],
  );

  const [jobs, metrics, latestEvent, snapshot, regimes] = await Promise.all([
    jobsQuery,
    metricsQuery,
    eventQuery,
    snapshotQuery,
    regimeQuery,
  ]);
  const metric = metrics.rows[0];

  return buildP8OpsSummary({
    now: input.now,
    schedulerSecretPresent: Boolean(input.env?.SCHEDULER_SECRET?.trim()),
    jobs: jobs.rows,
    counts: metric ? {
      queued: numeric(metric.queued),
      running: numeric(metric.running),
      succeeded: numeric(metric.succeeded),
      failed: numeric(metric.failed),
      cancelled: numeric(metric.cancelled),
      dead: numeric(metric.dead),
    } : undefined,
    deadTotal: numeric(metric?.dead_total),
    oldestQueuedAgeSeconds: metric?.oldest_queued_age_seconds === null
      ? null
      : numeric(metric?.oldest_queued_age_seconds),
    expiredLeaseCount: numeric(metric?.expired_lease_count),
    latestJobEventAt: latestEvent.rows[0]?.created_at ?? null,
    snapshot: snapshot.rows[0] ?? null,
    regimes: regimes.rows,
    memoryResponse: input.memoryResponse,
    memoryExpiresAt: input.memoryExpiresAt,
  });
}
