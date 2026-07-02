"use client";

// components/dashboard/ops/SystemFlowMap.tsx
// Expandable pipeline cards fed by /api/ops/system-state.

import { useState } from "react";
import type { SystemFlowStage, SystemStateResponse } from "@/lib/ops/systemState";
import { formatTimestamp, OpsStatusPill } from "./P8OpsUI";

type DisplayStage = Omit<SystemFlowStage, "jobType"> & { jobType?: SystemFlowStage["jobType"] };

const PRIMARY_FLOW_KEYS = [
  "market_ingest",
  "feature_snapshots",
  "regime_compute",
  "strategy_evaluation",
  "risk_gate",
  "paper_monitor",
] as const;

const SUPPORTING_FLOW_KEYS = ["dashboard_snapshots", "alerts_reports"] as const;

const titleOverride: Record<string, string> = {
  regime_compute: "Regime Classification",
  paper_monitor: "Paper Monitoring",
};

const realityLabel: Record<SystemFlowStage["dataReality"], string> = {
  real: "real data",
  stale: "stale data",
  mocked: "mocked",
  unavailable: "unavailable",
  disabled: "disabled",
};

const statusMeaning: Record<SystemFlowStage["status"], string> = {
  healthy: "The latest available signal for this stage is current enough to trust at face value.",
  warning: "The stage is wired, but the dashboard found a condition that needs review.",
  stale: "The stage has real data, but the latest success is older than the expected freshness window.",
  blocked: "The stage cannot currently complete successfully.",
  disabled: "The capability is intentionally unavailable in this environment or code path.",
  unknown: "The dashboard could not determine this stage's state from the available system data.",
};

const stagePurpose: Record<string, string> = {
  market_ingest: "Fetches closed BTC-USD candles and persists them as market bars.",
  feature_snapshots: "Computes deterministic indicator snapshots from persisted market bars.",
  regime_compute: "Classifies the market environment from persisted feature snapshots.",
  strategy_evaluation: "Runs deterministic strategy rules against feature windows and regime context.",
  risk_gate: "Approves, blocks, or resizes scheduled strategy signals before paper intent.",
  paper_monitor: "Updates simulated paper positions and PnL without touching a broker.",
  dashboard_snapshots: "Persists the display payload consumed by /api/signals.",
  alerts_reports: "Represents outbound alerting and report delivery capability.",
  live_execution: "Represents broker/live execution, which is intentionally disabled here.",
};

const numberToneClass: Record<SystemFlowStage["status"], string> = {
  healthy: "border-[var(--color-accent-green)]/40 bg-[var(--color-accent-green)]/10 text-[var(--color-accent-green)]",
  warning: "border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/10 text-[var(--color-accent-amber)]",
  stale: "border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/10 text-[var(--color-accent-amber)]",
  blocked: "border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/10 text-[var(--color-accent-red)]",
  disabled: "border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/10 text-[var(--color-accent-red)]",
  unknown: "border-[var(--color-border-default)] bg-[var(--color-surface-panel)] text-[var(--color-text-muted)]",
};

function stageFromFlow(flow: SystemFlowStage[], key: string): DisplayStage[] {
  const stage = flow.find((candidate) => candidate.key === key);
  if (!stage) return [];
  return [{ ...stage, title: titleOverride[stage.key] ?? stage.title }];
}

function displayStages(flow: SystemFlowStage[], execution?: SystemStateResponse["execution"]) {
  const primary = PRIMARY_FLOW_KEYS.flatMap((key) => stageFromFlow(flow, key));
  const supporting = SUPPORTING_FLOW_KEYS.flatMap((key) => stageFromFlow(flow, key));

  const liveExecution: DisplayStage[] = execution
    ? [
        {
          key: "live_execution",
          title: "Live Execution",
          status: "disabled",
          lastSuccessAt: null,
          lastAttemptAt: null,
          sourceOfTruth: execution.enforcedBy,
          dataReality: "disabled",
          note: "Blocked in code. No broker integration exists and live job types are rejected before any handler runs.",
          error: null,
          jobType: null,
        },
      ]
    : [];

  return [
    {
      title: "Primary flow",
      description: "Scheduled market data, feature, regime, strategy, risk, and paper-monitoring stages.",
      stages: primary,
    },
    {
      title: "Downstream and safety",
      description: "Display snapshots, reporting paths, and disabled live execution remain visible for trust checks.",
      stages: [...supporting, ...liveExecution],
    },
  ].filter((group) => group.stages.length > 0);
}

function displayValue(value: string | null | undefined): string {
  return value ?? "Unavailable";
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-panel)] px-3 py-2.5">
      <dt className="text-[10px] uppercase tracking-[.08em] text-[var(--color-text-dim)]">{label}</dt>
      <dd className="mt-1 break-words text-[13px] leading-[1.5] text-[var(--color-text-secondary)]">{value}</dd>
    </div>
  );
}

function StageCard({
  stage,
  index,
  isLast,
  expanded,
  onToggle,
}: {
  stage: DisplayStage;
  index: number;
  isLast: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const detailsId = `pipeline-stage-${stage.key}-details`;

  return (
    <div className="flex gap-[18px]">
      <div className="flex w-[30px] shrink-0 flex-col items-center">
        <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-full border text-[10px] font-semibold ${numberToneClass[stage.status]}`}>
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className={`mt-1 w-px flex-1 ${isLast ? "bg-transparent" : "bg-[var(--color-border-default)]"}`} />
      </div>

      <div className="min-w-0 flex-1 pb-[18px]">
        <article className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-surface-card)] px-5 py-[18px]">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={onToggle}
            className="block w-full rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-card)]"
          >
            <span className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex min-w-0 flex-wrap items-center gap-3">
                <span className="text-[16px] font-semibold text-[var(--color-text-primary)]">{stage.title}</span>
                <OpsStatusPill status={stage.status} />
              </span>
              <span className="inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--color-text-muted)]">
                {expanded ? "Hide details" : "Details"}
                <span aria-hidden="true" className="text-[14px] leading-none">
                  {expanded ? "-" : "+"}
                </span>
              </span>
            </span>

            <span className="mt-2 block text-[13px] leading-[1.55] text-[var(--color-text-muted)]">{stage.note}</span>

            <span className="mt-4 grid gap-4 border-t border-[var(--color-border-subtle)] pt-3 sm:grid-cols-2">
              <span>
                <span className="block text-[10px] uppercase tracking-[.08em] text-[var(--color-text-dim)]">Last success</span>
                <span className="mt-1 block font-mono text-[13px] text-[var(--color-text-secondary)]">{formatTimestamp(stage.lastSuccessAt)}</span>
              </span>
              <span>
                <span className="block text-[10px] uppercase tracking-[.08em] text-[var(--color-text-dim)]">Data reality</span>
                <span className="mt-1 block text-[13px] text-[var(--color-text-secondary)]">{realityLabel[stage.dataReality]}</span>
              </span>
            </span>
          </button>

          {expanded ? (
            <div id={detailsId} className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
              <dl className="grid gap-3 md:grid-cols-2">
                <DetailRow label="What this does" value={stagePurpose[stage.key] ?? "Unknown."} />
                <DetailRow label="Why it is labeled this way" value={stage.note} />
                <DetailRow label="Status explanation" value={statusMeaning[stage.status]} />
                <DetailRow label="Source of truth" value={displayValue(stage.sourceOfTruth)} />
                <DetailRow label="Last attempt" value={formatTimestamp(stage.lastAttemptAt)} />
                <DetailRow label="Last success" value={formatTimestamp(stage.lastSuccessAt)} />
                <DetailRow label="Data reality" value={realityLabel[stage.dataReality]} />
                <DetailRow label="Job type" value={stage.jobType ?? "Unavailable"} />
                <DetailRow label="Error" value={stage.error ?? "None reported"} />
              </dl>
            </div>
          ) : null}
        </article>
      </div>
    </div>
  );
}

export function SystemFlowMap({
  flow,
  execution,
}: {
  flow: SystemFlowStage[];
  execution?: SystemStateResponse["execution"];
}) {
  const [expandedStageKey, setExpandedStageKey] = useState<string | null>(null);
  const groups = displayStages(flow, execution);
  const totalStages = groups.reduce((count, group) => count + group.stages.length, 0);
  let stageIndex = 0;

  return (
    <section className="px-5 py-8 sm:px-10">
      <p className="mb-1 text-[11px] uppercase tracking-[.16em] text-[var(--color-text-dim)]">
        02 &middot; Pipeline
      </p>
      <h2 className="text-[24px] font-semibold tracking-normal text-[var(--color-text-primary)]">
        How data moves through the system
      </h2>
      <p className="mt-2 max-w-[700px] text-[14px] leading-[1.6] text-[var(--color-text-muted)]">
        Each stage stays simple until opened. A gray or amber stage means state that could not be
        confirmed or is stale; never assume green.
      </p>

      <div className="mt-7 space-y-6">
        {groups.map((group) => (
          <div key={group.title}>
            <div className="mb-3">
              <h3 className="text-[13px] font-semibold uppercase tracking-[.12em] text-[var(--color-text-secondary)]">
                {group.title}
              </h3>
              <p className="mt-1 text-[12px] leading-[1.5] text-[var(--color-text-dim)]">{group.description}</p>
            </div>

            <div className="flex flex-col">
              {group.stages.map((stage) => {
                stageIndex += 1;
                return (
                  <StageCard
                    key={stage.key}
                    stage={stage}
                    index={stageIndex}
                    isLast={stageIndex === totalStages}
                    expanded={expandedStageKey === stage.key}
                    onToggle={() => setExpandedStageKey((current) => (current === stage.key ? null : stage.key))}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
