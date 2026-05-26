// components/dashboard/ArchitecturePipeline.tsx
// Visual pipeline of the full intelligence architecture — centerpiece of the dashboard.

import { PIPELINE_STAGES, type StatusState } from "@/lib/dashboard/dashboardArchitecture";

const statusLabel: Record<StatusState, string> = {
  active:           "Active",
  in_progress:      "In Progress",
  pending:          "Pending",
  disabled:         "Disabled",
  planned:          "Planned",
  validated:        "Validated",
  needs_validation: "Needs Validation",
};

const statusColor: Record<StatusState, string> = {
  active:           "text-[var(--color-accent-green)]  border-[var(--color-accent-green)]",
  in_progress:      "text-[var(--color-accent-blue)]   border-[var(--color-accent-blue)]",
  pending:          "text-[var(--color-accent-amber)]  border-[var(--color-accent-amber)]",
  disabled:         "text-[var(--color-accent-red)]    border-[var(--color-accent-red)]",
  planned:          "text-[var(--color-text-muted)]    border-[var(--color-border-default)]",
  validated:        "text-[var(--color-accent-green)]  border-[var(--color-accent-green)]",
  needs_validation: "text-[var(--color-accent-amber)]  border-[var(--color-accent-amber)]",
};

const statusDot: Record<StatusState, string> = {
  active:           "bg-[var(--color-accent-green)]",
  in_progress:      "bg-[var(--color-accent-blue)]",
  pending:          "bg-[var(--color-accent-amber)]",
  disabled:         "bg-[var(--color-accent-red)]",
  planned:          "bg-[var(--color-text-dim)]",
  validated:        "bg-[var(--color-accent-green)]",
  needs_validation: "bg-[var(--color-accent-amber)]",
};

export function ArchitecturePipeline() {
  return (
    <section className="border-b border-[var(--color-border-default)] px-6 py-6">
      <div className="mb-5">
        <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.18em] uppercase mb-1">
          Intelligence Pipeline
        </p>
        <p className="text-[11px] text-[var(--color-text-muted)]">
          How information flows through the platform — from raw market data to risk-gated decisions.
        </p>
      </div>

      {/* Horizontal scrollable pipeline cards */}
      <div className="overflow-x-auto pb-2">
        <div className="flex gap-0 min-w-max">
          {PIPELINE_STAGES.map((stage, i) => (
            <div key={stage.name} className="flex items-start">
              {/* Card */}
              <div className="w-[188px] shrink-0 bg-[var(--color-surface-card)] border border-[var(--color-border-default)] rounded p-4">
                {/* Stage index + status dot */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span
                    className={`text-[8px] tracking-[.1em] px-2 py-[2px] border rounded-full uppercase ${statusColor[stage.status]}`}
                  >
                    {statusLabel[stage.status]}
                  </span>
                </div>

                {/* Stage name */}
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${statusDot[stage.status]}`} />
                  <p className="text-[12px] text-[var(--color-text-primary)] font-medium leading-tight">
                    {stage.name}
                  </p>
                </div>

                {/* Purpose */}
                <p className="text-[10px] text-[var(--color-text-muted)] leading-[1.55] mb-3">
                  {stage.purpose}
                </p>

                {/* Inputs */}
                {stage.inputs.length > 0 && (
                  <div className="mb-2">
                    <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase mb-1">Inputs</p>
                    <ul className="space-y-[2px]">
                      {stage.inputs.slice(0, 3).map((inp) => (
                        <li key={inp} className="text-[9px] text-[var(--color-text-muted)] leading-[1.4]">
                          · {inp}
                        </li>
                      ))}
                      {stage.inputs.length > 3 && (
                        <li className="text-[9px] text-[var(--color-text-dim)]">
                          +{stage.inputs.length - 3} more
                        </li>
                      )}
                    </ul>
                  </div>
                )}

                {/* Outputs */}
                {stage.outputs.length > 0 && (
                  <div>
                    <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase mb-1">Outputs</p>
                    <ul className="space-y-[2px]">
                      {stage.outputs.slice(0, 3).map((out) => (
                        <li key={out} className="text-[9px] text-[var(--color-text-muted)] leading-[1.4]">
                          · {out}
                        </li>
                      ))}
                      {stage.outputs.length > 3 && (
                        <li className="text-[9px] text-[var(--color-text-dim)]">
                          +{stage.outputs.length - 3} more
                        </li>
                      )}
                    </ul>
                  </div>
                )}

                {/* Maturity */}
                <p className="text-[8px] text-[var(--color-text-dim)] mt-3 pt-2 border-t border-[var(--color-border-subtle)]">
                  {stage.maturity}
                </p>
              </div>

              {/* Arrow connector (not after last card) */}
              {i < PIPELINE_STAGES.length - 1 && (
                <div className="flex items-center self-stretch px-1">
                  <span className="text-[var(--color-text-dim)] text-[10px]">→</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
