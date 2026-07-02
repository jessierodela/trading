// components/dashboard/ops/SystemFlowMap.tsx
// Conceptual pipeline flow map fed by /api/ops/system-state. Every stage shows
// derived status, last runs, source of truth, and data reality — no guessed
// health, no fake green.

import type { SystemFlowStage } from "@/lib/ops/systemState";
import { formatTimestamp, OpsStatusPill } from "./P8OpsUI";

const realityLabel: Record<SystemFlowStage["dataReality"], string> = {
  real: "real data",
  stale: "stale data",
  mocked: "mocked",
  unavailable: "no data",
  disabled: "disabled",
};

export function SystemFlowMap({ flow }: { flow: SystemFlowStage[] }) {
  return (
    <section className="border-b border-[var(--color-border-default)] px-4 py-5 sm:px-6">
      <div className="mb-4">
        <p className="text-[9px] uppercase tracking-[.18em] text-[var(--color-text-dim)]">
          System Flow Map
        </p>
        <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
          How data moves through the platform, with the live status of each stage.
          Statuses come from the jobs and snapshot tables — a gray stage means the
          state could not be determined, not that it is fine.
        </p>
      </div>

      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max items-stretch">
          {flow.map((stage, i) => (
            <div key={stage.key} className="flex items-stretch">
              <div className="flex w-[220px] shrink-0 flex-col rounded-md border border-[var(--color-border-default)] bg-[var(--color-surface-card)] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[8px] text-[var(--color-text-dim)]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <OpsStatusPill status={stage.status} />
                </div>

                <p className="text-[12px] font-medium leading-tight text-[var(--color-text-primary)]">
                  {stage.title}
                </p>

                <p className="mt-2 flex-1 text-[9px] leading-[1.55] text-[var(--color-text-muted)]">
                  {stage.note}
                </p>

                {stage.error ? (
                  <p className="mt-2 rounded border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red)]/5 px-2 py-1 text-[8px] leading-[1.4] text-[var(--color-accent-red)]">
                    {stage.error}
                  </p>
                ) : null}

                <dl className="mt-3 space-y-1 border-t border-[var(--color-border-subtle)] pt-2">
                  <div className="flex justify-between gap-2">
                    <dt className="text-[8px] uppercase text-[var(--color-text-dim)]">Last success</dt>
                    <dd className="text-right font-mono text-[8px] text-[var(--color-text-secondary)]">
                      {formatTimestamp(stage.lastSuccessAt)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-[8px] uppercase text-[var(--color-text-dim)]">Last attempt</dt>
                    <dd className="text-right font-mono text-[8px] text-[var(--color-text-secondary)]">
                      {formatTimestamp(stage.lastAttemptAt)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-[8px] uppercase text-[var(--color-text-dim)]">Data</dt>
                    <dd className="text-right text-[8px] text-[var(--color-text-secondary)]">
                      {realityLabel[stage.dataReality]}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="shrink-0 text-[8px] uppercase text-[var(--color-text-dim)]">Source</dt>
                    <dd className="min-w-0 truncate text-right text-[8px] text-[var(--color-text-muted)]" title={stage.sourceOfTruth}>
                      {stage.sourceOfTruth}
                    </dd>
                  </div>
                </dl>
              </div>

              {i < flow.length - 1 ? (
                <div className="flex items-center px-1 text-[10px] text-[var(--color-text-dim)]">→</div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
