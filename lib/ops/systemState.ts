/**
 * lib/ops/systemState.ts
 *
 * Composes the existing P8 ops summary (lib/ops/p8Summary.ts) and risk gate
 * summary (lib/ops/riskGateSummary.ts) into a single dashboard-facing system
 * state: a conceptual pipeline flow map, a prioritized attention list, and a
 * data-truthfulness classification.
 *
 * Pure builder + thin route loader, mirroring the P8/P11 ops conventions:
 * read-only, no mutations, no job enqueue, no OpenAI. Every derived status
 * must be provable from the inputs — when something cannot be determined it
 * is reported as "unknown" with a reason, never guessed.
 */
import type { Pool } from "pg";
import type {
  P8OpsSummary,
  P8PipelineStageName,
  ScheduledStageSummary,
} from "@/lib/ops/p8Types";
import { loadP8OpsSummary } from "@/lib/ops/p8Summary";
import {
  loadRiskGateSummary,
  type RiskGateOpsSummary,
} from "@/lib/ops/riskGateSummary";
import { FORBIDDEN_LIVE_JOB_TYPES } from "@/lib/jobs/types";

// ── Public shapes ─────────────────────────────────────────────────────────────

export type FlowStageStatus =
  | "healthy"
  | "warning"
  | "stale"
  | "blocked"
  | "disabled"
  | "unknown";

export type DataReality = "real" | "stale" | "mocked" | "unavailable" | "disabled";

export interface SystemFlowStage {
  key: string;
  title: string;
  /** Scheduled job type backing this stage, or null when derived elsewhere. */
  jobType: P8PipelineStageName | null;
  status: FlowStageStatus;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  sourceOfTruth: string;
  dataReality: DataReality;
  /** Plain-English state description for non-experts. */
  note: string;
  error: string | null;
}

export type AttentionSeverity = "critical" | "warning" | "info";

export interface AttentionItem {
  severity: AttentionSeverity;
  title: string;
  detail: string;
  /** Which automated check produced this item. */
  source: string;
}

export type TruthfulnessReality =
  | "real"
  | "static"
  | "mock"
  | "missing"
  | "stale"
  | "disabled"
  | "display_only";

export interface TruthfulnessEntry {
  area: string;
  reality: TruthfulnessReality;
  detail: string;
}

export interface SystemStateResponse {
  generatedAt: string;
  ops: {
    available: boolean;
    reason: string | null;
    summary: P8OpsSummary | null;
  };
  riskGate: {
    available: boolean;
    reason: string | null;
    summary: RiskGateOpsSummary | null;
  };
  scheduler: {
    cronExpression: string;
    nextExpectedFeedAt: string | null;
  };
  flow: SystemFlowStage[];
  attention: AttentionItem[];
  truthfulness: TruthfulnessEntry[];
  execution: {
    liveExecutionDisabled: true;
    enforcedBy: string;
    forbiddenJobTypes: string[];
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Scheduled pipeline runs hourly; anything older than this is stale. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** Queued jobs older than this suggest the worker is not draining the queue. */
const QUEUE_AGE_WARNING_SECONDS = 30 * 60;

const JOBS_SOURCE = "jobs table via /api/ops/p8";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isFresh(iso: string | null, now: Date): boolean {
  if (iso === null) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && now.getTime() - t <= STALE_AFTER_MS;
}

function latestIso(...values: Array<string | null>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (value === null) continue;
    const t = new Date(value).getTime();
    if (!Number.isFinite(t)) continue;
    if (best === null || t > new Date(best).getTime()) best = value;
  }
  return best;
}

/** Next fire time for the fixed "5 * * * *" schedule (minute 5, every hour). */
export function nextHourlyFeedAt(now: Date): string {
  const next = new Date(now.getTime());
  next.setUTCSeconds(0, 0);
  if (next.getUTCMinutes() >= 5) {
    next.setUTCHours(next.getUTCHours() + 1);
  }
  next.setUTCMinutes(5);
  return next.toISOString();
}

function findStage(
  summary: P8OpsSummary | null,
  jobType: P8PipelineStageName,
): ScheduledStageSummary | null {
  if (summary === null) return null;
  return summary.pipeline.stages.find((stage) => stage.stage === jobType) ?? null;
}

/** Flow stage derived from a scheduled job stage in the latest feed. */
function jobBackedStage(input: {
  key: string;
  title: string;
  jobType: P8PipelineStageName;
  purpose: string;
  summary: P8OpsSummary | null;
  opsReason: string | null;
  now: Date;
}): SystemFlowStage {
  const { key, title, jobType, purpose, summary, opsReason, now } = input;

  if (summary === null) {
    return {
      key,
      title,
      jobType,
      status: "unknown",
      lastSuccessAt: null,
      lastAttemptAt: null,
      sourceOfTruth: JOBS_SOURCE,
      dataReality: "unavailable",
      note: `${purpose} State unknown: ${opsReason ?? "operations data unavailable"}.`,
      error: null,
    };
  }

  const stage = findStage(summary, jobType);
  if (stage === null || stage.status === "missing") {
    return {
      key,
      title,
      jobType,
      status: "unknown",
      lastSuccessAt: null,
      lastAttemptAt: null,
      sourceOfTruth: JOBS_SOURCE,
      dataReality: "unavailable",
      note: `${purpose} No run of this stage was found in the latest scheduled feed.`,
      error: null,
    };
  }

  const lastSuccessAt = stage.status === "succeeded" ? stage.completedAt : null;
  const lastAttemptAt = latestIso(
    stage.completedAt,
    stage.failedAt,
    stage.startedAt,
    stage.createdAt,
  );

  if (stage.status === "succeeded") {
    const fresh = isFresh(stage.completedAt, now);
    return {
      key,
      title,
      jobType,
      status: fresh ? "healthy" : "stale",
      lastSuccessAt,
      lastAttemptAt,
      sourceOfTruth: JOBS_SOURCE,
      dataReality: fresh ? "real" : "stale",
      note: fresh
        ? `${purpose} Last scheduled run succeeded.`
        : `${purpose} Last success is older than 2 hours — the hourly pipeline has not refreshed it.`,
      error: null,
    };
  }

  if (stage.status === "running") {
    return {
      key,
      title,
      jobType,
      status: "healthy",
      lastSuccessAt,
      lastAttemptAt,
      sourceOfTruth: JOBS_SOURCE,
      dataReality: "real",
      note: `${purpose} A run is currently in progress.`,
      error: null,
    };
  }

  if (stage.status === "queued") {
    return {
      key,
      title,
      jobType,
      status: "warning",
      lastSuccessAt,
      lastAttemptAt,
      sourceOfTruth: JOBS_SOURCE,
      dataReality: "unavailable",
      note: `${purpose} A run is queued and waiting for the worker.`,
      error: null,
    };
  }

  if (stage.status === "failed" || stage.status === "dead") {
    return {
      key,
      title,
      jobType,
      status: "blocked",
      lastSuccessAt,
      lastAttemptAt,
      sourceOfTruth: JOBS_SOURCE,
      dataReality: "unavailable",
      note:
        stage.status === "dead"
          ? `${purpose} The latest run exhausted its retries and was dead-lettered.`
          : `${purpose} The latest run failed without retry.`,
      error: stage.error,
    };
  }

  // cancelled
  return {
    key,
    title,
    jobType,
    status: "warning",
    lastSuccessAt,
    lastAttemptAt,
    sourceOfTruth: JOBS_SOURCE,
    dataReality: "unavailable",
    note: `${purpose} The latest run was cancelled.`,
    error: stage.error,
  };
}

// ── Flow map ──────────────────────────────────────────────────────────────────

function buildFlow(input: {
  ops: P8OpsSummary | null;
  opsReason: string | null;
  riskGate: RiskGateOpsSummary | null;
  riskGateReason: string | null;
  now: Date;
}): SystemFlowStage[] {
  const { ops, opsReason, riskGate, riskGateReason, now } = input;

  const stages: SystemFlowStage[] = [
    jobBackedStage({
      key: "market_ingest",
      title: "Market Data Ingest",
      jobType: "market.ingest.latest",
      purpose: "Fetches closed BTC-USD candles from Coinbase and persists them as market bars.",
      summary: ops,
      opsReason,
      now,
    }),
    jobBackedStage({
      key: "feature_snapshots",
      title: "Feature Snapshots",
      jobType: "features.compute",
      purpose: "Computes deterministic indicators (RSI, MACD, EMA, ATR…) from persisted bars.",
      summary: ops,
      opsReason,
      now,
    }),
    jobBackedStage({
      key: "regime_compute",
      title: "Regime Compute",
      jobType: "regime.compute",
      purpose: "Classifies the market environment from persisted feature snapshots.",
      summary: ops,
      opsReason,
      now,
    }),
    jobBackedStage({
      key: "strategy_evaluation",
      title: "Strategy Evaluation",
      jobType: "strategies.evaluate",
      purpose: "Runs deterministic strategy rules over feature windows plus regime context.",
      summary: ops,
      opsReason,
      now,
    }),
  ];

  // Risk gate — evaluated inside the scheduled strategy path (P11); its
  // source of truth is risk_decisions/trade_intents, not a pipeline stage.
  if (riskGate === null) {
    stages.push({
      key: "risk_gate",
      title: "Risk Gate",
      jobType: null,
      status: "unknown",
      lastSuccessAt: null,
      lastAttemptAt: null,
      sourceOfTruth: "risk_decisions + trade_intents via /api/ops/risk-gate",
      dataReality: "unavailable",
      note: `Approves, blocks, or resizes scheduled strategy signals. State unknown: ${riskGateReason ?? "risk gate data unavailable"}.`,
      error: null,
    });
  } else {
    const lastAttemptAt = latestIso(
      riskGate.latestApprovedIntent?.createdAt ?? null,
      riskGate.latestRejectedDecision?.evaluatedAt ?? null,
    );
    stages.push({
      key: "risk_gate",
      title: "Risk Gate",
      jobType: null,
      status: "healthy",
      lastSuccessAt: lastAttemptAt,
      lastAttemptAt,
      sourceOfTruth: "risk_decisions + trade_intents via /api/ops/risk-gate",
      dataReality: riskGate.signalsEvaluated > 0 ? "real" : "unavailable",
      note:
        riskGate.signalsEvaluated > 0
          ? `Approves, blocks, or resizes scheduled strategy signals. ${riskGate.signalsEvaluated} evaluated so far (${riskGate.approvedCount} approved, ${riskGate.rejectedCount} rejected).`
          : "Approves, blocks, or resizes scheduled strategy signals. Wired into the scheduled path, but no signals have been evaluated yet.",
      error: null,
    });
  }

  stages.push(
    jobBackedStage({
      key: "paper_monitor",
      title: "Paper Monitor",
      jobType: "paper.monitor",
      purpose: "Updates simulated paper positions and PnL — no real money, no broker.",
      summary: ops,
      opsReason,
      now,
    }),
  );

  // Dashboard snapshots — richer state available from the snapshot section.
  const snap = ops?.snapshot.latestDashboardSnapshot ?? null;
  if (ops === null) {
    stages.push({
      key: "dashboard_snapshots",
      title: "Dashboard Snapshots",
      jobType: "dashboard.snapshot",
      status: "unknown",
      lastSuccessAt: null,
      lastAttemptAt: null,
      sourceOfTruth: "dashboard_snapshots table via /api/ops/p8",
      dataReality: "unavailable",
      note: `Persists the display payload that /api/signals serves. State unknown: ${opsReason ?? "operations data unavailable"}.`,
      error: null,
    });
  } else if (snap === null) {
    stages.push({
      key: "dashboard_snapshots",
      title: "Dashboard Snapshots",
      jobType: "dashboard.snapshot",
      status: "warning",
      lastSuccessAt: null,
      lastAttemptAt: null,
      sourceOfTruth: "dashboard_snapshots table via /api/ops/p8",
      dataReality: "unavailable",
      note: "Persists the display payload that /api/signals serves. No persisted snapshot exists yet.",
      error: null,
    });
  } else {
    stages.push({
      key: "dashboard_snapshots",
      title: "Dashboard Snapshots",
      jobType: "dashboard.snapshot",
      status: snap.isExpired ? "stale" : "healthy",
      lastSuccessAt: snap.generatedAt,
      lastAttemptAt: snap.generatedAt,
      sourceOfTruth: "dashboard_snapshots table via /api/ops/p8",
      dataReality: snap.isExpired ? "stale" : "real",
      note: snap.isExpired
        ? "Persists the display payload that /api/signals serves. The latest snapshot has expired and no fresh one has replaced it."
        : "Persists the display payload that /api/signals serves. Latest snapshot is current.",
      error: null,
    });
  }

  // Alerts / reports — telegram.refresh is a declared job type with no
  // implemented handler in the scheduled feed. Reported as disabled, not fake.
  stages.push({
    key: "alerts_reports",
    title: "Alerts / Reports",
    jobType: null,
    status: "disabled",
    lastSuccessAt: null,
    lastAttemptAt: null,
    sourceOfTruth: "telegram.refresh job type (declared, not scheduled)",
    dataReality: "disabled",
    note: "Outbound alerting is deferred. The telegram.refresh job type exists but is not part of the scheduled feed.",
    error: null,
  });

  return stages;
}

// ── Attention list ────────────────────────────────────────────────────────────

function buildAttention(input: {
  ops: P8OpsSummary | null;
  opsReason: string | null;
  riskGate: RiskGateOpsSummary | null;
  riskGateReason: string | null;
  flow: SystemFlowStage[];
}): AttentionItem[] {
  const { ops, opsReason, riskGate, riskGateReason, flow } = input;
  const items: AttentionItem[] = [];

  if (ops === null) {
    items.push({
      severity: "critical",
      title: "Operations data unavailable",
      detail: `/api/ops/p8 could not be read: ${opsReason ?? "unknown reason"}. Most dashboard state below is unknown until this recovers.`,
      source: "ops availability",
    });
  }

  if (riskGate === null) {
    items.push({
      severity: "warning",
      title: "Risk gate data unavailable",
      detail: `/api/ops/risk-gate could not be read: ${riskGateReason ?? "unknown reason"}.`,
      source: "risk gate availability",
    });
  }

  if (ops !== null) {
    const { counts, oldestQueuedAgeSeconds, expiredLeaseCount } = ops.queue;

    if (counts.dead > 0) {
      items.push({
        severity: "critical",
        title: `${counts.dead} dead-lettered job${counts.dead === 1 ? "" : "s"}`,
        detail: "Jobs exhausted their retries in the recent window. Inspect the queue health panel for the failing job types.",
        source: "queue counts",
      });
    }
    if (counts.failed > 0) {
      items.push({
        severity: "warning",
        title: `${counts.failed} failed job${counts.failed === 1 ? "" : "s"}`,
        detail: "Jobs failed without retry in the recent window. Check the recent jobs table for error messages.",
        source: "queue counts",
      });
    }
    if (expiredLeaseCount > 0) {
      items.push({
        severity: "warning",
        title: `${expiredLeaseCount} expired job lease${expiredLeaseCount === 1 ? "" : "s"}`,
        detail: "Running jobs lost their worker lease. They will be recovered on the next worker pass, but this suggests worker interruptions.",
        source: "queue leases",
      });
    }
    if (
      oldestQueuedAgeSeconds !== null &&
      oldestQueuedAgeSeconds > QUEUE_AGE_WARNING_SECONDS
    ) {
      items.push({
        severity: "warning",
        title: "Queued work is not being drained",
        detail: `The oldest queued job has waited ${Math.round(oldestQueuedAgeSeconds / 60)} minutes. The worker may not be running.`,
        source: "queue age",
      });
    }

    if (ops.worker.status === "attention" || ops.worker.status === "unknown") {
      items.push({
        severity: "warning",
        title: `Worker needs attention (${ops.worker.status})`,
        detail: ops.worker.recommendation,
        source: "worker status",
      });
    }

    if (!ops.scheduler.schedulerSecretPresent) {
      items.push({
        severity: "warning",
        title: "SCHEDULER_SECRET is not configured",
        detail: "The external scheduler cannot authenticate against /api/jobs/schedule in this environment, so no new scheduled feeds will be accepted here.",
        source: "scheduler config",
      });
    }

    const snap = ops.snapshot.latestDashboardSnapshot;
    if (snap === null) {
      items.push({
        severity: "warning",
        title: "No persisted dashboard snapshot",
        detail: "/api/signals is serving from memory or empty data instead of a persisted snapshot.",
        source: "snapshot freshness",
      });
    } else if (snap.isExpired) {
      items.push({
        severity: "warning",
        title: "Dashboard snapshot has expired",
        detail: `The latest snapshot was generated ${snap.generatedAt} and is past its expiry. Signals shown may be outdated.`,
        source: "snapshot freshness",
      });
    }

    const staleRegimes = ops.regime.symbols.filter((row) => row.stale);
    if (staleRegimes.length > 0) {
      items.push({
        severity: "warning",
        title: `Stale regime state for ${staleRegimes.length} symbol${staleRegimes.length === 1 ? "" : "s"}`,
        detail: `Regime data older than the freshness window for: ${staleRegimes.map((row) => row.symbol).join(", ")}.`,
        source: "regime freshness",
      });
    }

    const unmetReadiness = ops.readiness.filter((item) => item.status !== "pass");
    if (unmetReadiness.length > 0) {
      items.push({
        severity: "info",
        title: `${unmetReadiness.length} production readiness item${unmetReadiness.length === 1 ? "" : "s"} not passing`,
        detail: unmetReadiness.map((item) => `${item.label} (${item.status})`).join("; "),
        source: "readiness checklist",
      });
    }
  }

  for (const stage of flow) {
    if (stage.status === "blocked") {
      items.push({
        severity: "critical",
        title: `Pipeline stage blocked: ${stage.title}`,
        detail: stage.error ?? stage.note,
        source: "flow map",
      });
    }
  }

  if (items.length === 0) {
    items.push({
      severity: "info",
      title: "No issues detected",
      detail: "All automated checks passed. This covers queue health, worker liveness, snapshot and regime freshness, scheduler config, and pipeline stage status — not correctness of research results.",
      source: "all checks",
    });
  }

  const rank: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ── Truthfulness ──────────────────────────────────────────────────────────────

function buildTruthfulness(input: {
  ops: P8OpsSummary | null;
  riskGate: RiskGateOpsSummary | null;
}): TruthfulnessEntry[] {
  const { ops, riskGate } = input;
  const entries: TruthfulnessEntry[] = [];

  // Live-derived classifications.
  if (ops === null) {
    entries.push({
      area: "Operations state (scheduler, worker, queue, pipeline)",
      reality: "missing",
      detail: "The operations API is unavailable, so live operations state cannot be shown.",
    });
  } else {
    entries.push({
      area: "Operations state (scheduler, worker, queue, pipeline)",
      reality: "real",
      detail: "Read from the jobs, job_events, and dashboard_snapshots tables on every poll.",
    });

    const snap = ops.snapshot.latestDashboardSnapshot;
    if (ops.snapshot.signalsSource === "dashboard_snapshots" && snap !== null) {
      entries.push({
        area: "Signals payload (/api/signals)",
        reality: snap.isExpired ? "stale" : "real",
        detail: snap.isExpired
          ? "Served from a persisted snapshot that has passed its expiry."
          : "Served from a persisted, unexpired dashboard snapshot.",
      });
    } else if (ops.snapshot.signalsSource === "memCache") {
      entries.push({
        area: "Signals payload (/api/signals)",
        reality: "stale",
        detail: "Served from an in-memory cache, not a persisted snapshot. It disappears on restart.",
      });
    } else {
      entries.push({
        area: "Signals payload (/api/signals)",
        reality: "missing",
        detail: "No persisted snapshot and no memory cache — the signals API returns empty data.",
      });
    }

    const freshRegimes = ops.regime.symbols.filter((row) => !row.stale && row.regime !== null);
    const totalRegimes = ops.regime.symbols.length;
    entries.push({
      area: "Regime state per symbol",
      reality: freshRegimes.length === 0 ? "stale" : freshRegimes.length < totalRegimes ? "stale" : "real",
      detail: `${freshRegimes.length} of ${totalRegimes} tracked symbols have fresh persisted regime state.`,
    });
  }

  entries.push({
    area: "Risk gate decisions",
    reality: riskGate === null ? "missing" : riskGate.signalsEvaluated > 0 ? "real" : "missing",
    detail:
      riskGate === null
        ? "The risk gate API is unavailable."
        : riskGate.signalsEvaluated > 0
          ? "Persisted risk_decisions rows from the scheduled strategy path."
          : "The risk gate is wired but has not evaluated any signals yet.",
  });

  // Classifications that are true by construction of this codebase.
  entries.push(
    {
      area: "Paper trading positions and PnL",
      reality: "real",
      detail: "Persisted simulated positions read from the database. Simulated fills — not brokerage data.",
    },
    {
      area: "Header market tickers",
      reality: "display_only",
      detail: "External quotes for context only. Nothing on this platform trades against them.",
    },
    {
      area: "Architecture reference panels (agents, regimes, strategy notes, asset coverage)",
      reality: "static",
      detail: "Hand-written descriptions of the system design and research findings. They do not read live state and do not update on their own.",
    },
    {
      area: "Outbound alerts (Telegram)",
      reality: "disabled",
      detail: "Declared job type without a scheduled handler. No alerts are being sent.",
    },
    {
      area: "Live trade execution",
      reality: "disabled",
      detail: "Blocked in code: live execution job types are rejected at the job store layer.",
    },
  );

  return entries;
}

// ── Top-level builder + loader ────────────────────────────────────────────────

export interface SystemStateBuildInput {
  now?: Date;
  ops: P8OpsSummary | null;
  opsReason?: string | null;
  riskGate: RiskGateOpsSummary | null;
  riskGateReason?: string | null;
}

export function buildSystemState(input: SystemStateBuildInput): SystemStateResponse {
  const now = input.now ?? new Date();
  const opsReason = input.opsReason ?? null;
  const riskGateReason = input.riskGateReason ?? null;

  const flow = buildFlow({
    ops: input.ops,
    opsReason,
    riskGate: input.riskGate,
    riskGateReason,
    now,
  });

  return {
    generatedAt: now.toISOString(),
    ops: {
      available: input.ops !== null,
      reason: input.ops === null ? (opsReason ?? "unavailable") : null,
      summary: input.ops,
    },
    riskGate: {
      available: input.riskGate !== null,
      reason: input.riskGate === null ? (riskGateReason ?? "unavailable") : null,
      summary: input.riskGate,
    },
    scheduler: {
      cronExpression: "5 * * * *",
      nextExpectedFeedAt: nextHourlyFeedAt(now),
    },
    flow,
    attention: buildAttention({
      ops: input.ops,
      opsReason,
      riskGate: input.riskGate,
      riskGateReason,
      flow,
    }),
    truthfulness: buildTruthfulness({ ops: input.ops, riskGate: input.riskGate }),
    execution: {
      liveExecutionDisabled: true,
      enforcedBy: "lib/jobs/types.ts FORBIDDEN_LIVE_JOB_TYPES — rejected at the job store layer before any handler runs",
      forbiddenJobTypes: [...FORBIDDEN_LIVE_JOB_TYPES],
    },
  };
}

export async function loadSystemState(input: {
  pool: Pool;
  env: NodeJS.ProcessEnv;
  memoryResponse: object | null;
  memoryExpiresAt?: number;
  now?: Date;
}): Promise<SystemStateResponse> {
  let ops: P8OpsSummary | null = null;
  let opsReason: string | null = null;
  let riskGate: RiskGateOpsSummary | null = null;
  let riskGateReason: string | null = null;

  try {
    ops = await loadP8OpsSummary({
      pool: input.pool,
      env: input.env,
      memoryResponse: input.memoryResponse,
      memoryExpiresAt: input.memoryExpiresAt,
    });
  } catch (error) {
    opsReason = error instanceof Error ? error.message : String(error);
  }

  try {
    riskGate = await loadRiskGateSummary({ pool: input.pool, now: input.now });
  } catch (error) {
    riskGateReason = error instanceof Error ? error.message : String(error);
  }

  return buildSystemState({ now: input.now, ops, opsReason, riskGate, riskGateReason });
}
