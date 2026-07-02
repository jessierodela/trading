// components/dashboard/ops/SystemFlowMap.tsx
// Vertical pipeline stepper fed by /api/ops/system-state. Every stage shows
// derived status, last success, source of truth, and data reality.

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
];

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

const numberToneClass: Record<string, string> = {
  healthy: "border-[var(--color-accent-green)]/40 bg-[var(--color-accent-green)]/10 text-[var(--color-accent-green)]",
  warning: "border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/10 text-[var(--color-accent-amber)]",
  stale: "border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/10 text-[var(--color-accent-amber)]",
  blocked: "border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/10 text-[var(--color-accent-red)]",
  disabled: "border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/10 text-[var(--color-accent-red)]",
  unknown: "border-[var(--color-border-default)] bg-[var(--color-surface-panel)] text-[var(--color-text-muted)]",
};

function displayStages(flow: SystemFlowStage[], execution?: SystemStateResponse["execution"]): DisplayStage[] {
  const primary = PRIMARY_FLOW_KEYS.flatMap((key) => {
    const stage = flow.find((candidate) => candidate.key === key);
    if (!stage) return [];
    return [{ ...stage, title: titleOverride[stage.key] ?? stage.title }];
  });

  if (!execution) return primary;

  return [
    ...primary,
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
    },
  ];
}

export function SystemFlowMap({
  flow,
  execution,
}: {
  flow: SystemFlowStage[];
  execution?: SystemStateResponse["execution"];
}) {
  const stages = displayStages(flow, execution);

  return (
    <section className="px-5 py-8 sm:px-10">
      <p className="mb-1 text-[11px] uppercase tracking-[.16em] text-[var(--color-text-dim)]">
        02 &middot; Pipeline
      </p>
      <h2 className="text-[24px] font-semibold tracking-normal text-[var(--color-text-primary)]">
        How data moves through the system
      </h2>
      <p className="mt-2 max-w-[700px] text-[14px] leading-[1.6] text-[var(--color-text-muted)]">
        Each stage reports its own status. A gray or amber stage means state that could not be
        confirmed or is stale; never assume green.
      </p>

      <div className="mt-7 flex flex-col">
        {stages.map((stage, index) => (
          <div key={stage.key} className="flex gap-[18px]">
            <div className="flex w-[30px] shrink-0 flex-col items-center">
              <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-full border text-[10px] font-semibold ${numberToneClass[stage.status]}`}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className={`mt-1 w-px flex-1 ${index === stages.length - 1 ? "bg-transparent" : "bg-[var(--color-border-default)]"}`} />
            </div>

            <div className="min-w-0 flex-1 pb-[18px]">
              <article className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-surface-card)] px-5 py-[18px]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-[16px] font-semibold text-[var(--color-text-primary)]">{stage.title}</h3>
                  <OpsStatusPill status={stage.status} />
                </div>

                <p className="mt-2 text-[13px] leading-[1.55] text-[var(--color-text-muted)]">{stage.note}</p>

                {stage.error ? (
                  <p className="mt-3 rounded-md border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red)]/5 px-3 py-2 text-[12px] leading-[1.45] text-[var(--color-accent-red)]">
                    {stage.error}
                  </p>
                ) : null}

                <dl className="mt-4 grid gap-4 border-t border-[var(--color-border-subtle)] pt-3 sm:grid-cols-3">
                  <div>
                    <dt className="text-[10px] uppercase tracking-[.08em] text-[var(--color-text-dim)]">Last success</dt>
                    <dd className="mt-1 font-mono text-[13px] text-[var(--color-text-secondary)]">{formatTimestamp(stage.lastSuccessAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-[.08em] text-[var(--color-text-dim)]">Data</dt>
                    <dd className="mt-1 text-[13px] text-[var(--color-text-secondary)]">{realityLabel[stage.dataReality]}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[10px] uppercase tracking-[.08em] text-[var(--color-text-dim)]">Source</dt>
                    <dd className="mt-1 truncate font-mono text-[13px] text-[var(--color-text-muted)]" title={stage.sourceOfTruth}>
                      {stage.sourceOfTruth}
                    </dd>
                  </div>
                </dl>
              </article>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
