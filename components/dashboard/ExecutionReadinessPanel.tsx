// components/dashboard/ExecutionReadinessPanel.tsx
// Clearly communicates that live execution is intentionally blocked.

import { EXECUTION_REQUIREMENTS, type StatusState } from "@/lib/dashboard/dashboardArchitecture";

const statusLabel: Record<StatusState, string> = {
  active:           "Complete",
  in_progress:      "In Progress",
  pending:          "Pending",
  disabled:         "Disabled",
  planned:          "Planned",
  validated:        "Validated",
  needs_validation: "Needs Validation",
};

const statusColor: Record<StatusState, string> = {
  active:           "text-[var(--color-accent-green)]",
  in_progress:      "text-[var(--color-accent-blue)]",
  pending:          "text-[var(--color-accent-amber)]",
  disabled:         "text-[var(--color-accent-red)]",
  planned:          "text-[var(--color-text-dim)]",
  validated:        "text-[var(--color-accent-green)]",
  needs_validation: "text-[var(--color-accent-amber)]",
};

const dotColor: Record<StatusState, string> = {
  active:           "bg-[var(--color-accent-green)]",
  in_progress:      "bg-[var(--color-accent-blue)]",
  pending:          "bg-[var(--color-surface-hover)] border border-[var(--color-border-default)]",
  disabled:         "bg-[var(--color-accent-red)]",
  planned:          "bg-[var(--color-text-dim)]",
  validated:        "bg-[var(--color-accent-green)]",
  needs_validation: "bg-[var(--color-accent-amber)]",
};

export function ExecutionReadinessPanel() {
  const pending = EXECUTION_REQUIREMENTS.filter((r) => r.status === "pending").length;
  const inProgress = EXECUTION_REQUIREMENTS.filter((r) => r.status === "in_progress").length;

  return (
    <section className="border-b border-[var(--color-border-default)] px-6 py-6">
      <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.18em] uppercase mb-5">
        Execution Readiness
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Main message */}
        <div className="bg-[var(--color-surface-card)] border border-[var(--color-border-default)] rounded p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-[var(--color-accent-red)] animate-pulse-amber" />
            <p className="text-[13px] text-[var(--color-accent-red)] font-medium tracking-[.04em]">
              Live execution is intentionally disabled.
            </p>
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)] leading-[1.65] mb-4">
            The platform is currently in research and validation mode. Execution will remain disabled
            until the risk engine, position sizing, kill switch, drawdown limits, and router validation
            requirements are implemented.
          </p>
          <div className="flex gap-4 pt-3 border-t border-[var(--color-border-subtle)]">
            <div>
              <p className="text-[16px] font-light text-[var(--color-accent-amber)]">{pending}</p>
              <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">Pending</p>
            </div>
            <div>
              <p className="text-[16px] font-light text-[var(--color-accent-blue)]">{inProgress}</p>
              <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">In Progress</p>
            </div>
            <div>
              <p className="text-[16px] font-light text-[var(--color-text-dim)]">0</p>
              <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">Complete</p>
            </div>
          </div>
        </div>

        {/* Requirements checklist */}
        <div>
          <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.12em] uppercase mb-3">
            Required Before Execution
          </p>
          <ul className="space-y-[8px]">
            {EXECUTION_REQUIREMENTS.map((req) => (
              <li key={req.label} className="flex items-center gap-3">
                <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${dotColor[req.status]}`} />
                <span className="text-[11px] text-[var(--color-text-secondary)] flex-1">{req.label}</span>
                <span className={`text-[8px] tracking-[.08em] uppercase ${statusColor[req.status]}`}>
                  {statusLabel[req.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
