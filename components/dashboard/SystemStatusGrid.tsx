// components/dashboard/SystemStatusGrid.tsx
// Quick system-level snapshot — no brokerage widgets.

import { SYSTEM_STATUS, type StatusState } from "@/lib/dashboard/dashboardArchitecture";

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
  active:           "text-[var(--color-accent-green)]",
  in_progress:      "text-[var(--color-accent-blue)]",
  pending:          "text-[var(--color-accent-amber)]",
  disabled:         "text-[var(--color-accent-red)]",
  planned:          "text-[var(--color-text-muted)]",
  validated:        "text-[var(--color-accent-green)]",
  needs_validation: "text-[var(--color-accent-amber)]",
};

const dotColor: Record<StatusState, string> = {
  active:           "bg-[var(--color-accent-green)] animate-pulse-dot",
  in_progress:      "bg-[var(--color-accent-blue)]",
  pending:          "bg-[var(--color-accent-amber)] animate-pulse-amber",
  disabled:         "bg-[var(--color-accent-red)]",
  planned:          "bg-[var(--color-text-dim)]",
  validated:        "bg-[var(--color-accent-green)]",
  needs_validation: "bg-[var(--color-accent-amber)]",
};

export function SystemStatusGrid() {
  return (
    <section className="border-b border-[var(--color-border-default)] px-6 py-6">
      <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.18em] uppercase mb-4">
        System Status
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-[1px] bg-[var(--color-border-default)]">
        {SYSTEM_STATUS.map((card) => (
          <div
            key={card.label}
            className="bg-[var(--color-surface-card)] px-4 py-4"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${dotColor[card.status]}`} />
              <span className={`text-[9px] tracking-[.1em] uppercase ${statusColor[card.status]}`}>
                {statusLabel[card.status]}
              </span>
            </div>
            <p className="text-[11px] text-[var(--color-text-primary)] mb-1 font-medium">
              {card.label}
            </p>
            <p className="text-[9px] text-[var(--color-text-muted)] leading-[1.55]">
              {card.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
