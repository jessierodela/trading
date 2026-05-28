// components/dashboard/AgentStackOverview.tsx
// Intelligence layers shown as agents, not trade widgets.

import { AGENTS, type StatusState } from "@/lib/dashboard/dashboardArchitecture";

const statusLabel: Record<StatusState, string> = {
  active:           "Active",
  in_progress:      "In Progress",
  pending:          "Pending",
  disabled:         "Disabled",
  planned:          "Planned",
  validated:        "Validated",
  needs_validation: "Needs Validation",
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

const statusTextColor: Record<StatusState, string> = {
  active:           "text-[var(--color-accent-green)]",
  in_progress:      "text-[var(--color-accent-blue)]",
  pending:          "text-[var(--color-accent-amber)]",
  disabled:         "text-[var(--color-accent-red)]",
  planned:          "text-[var(--color-text-dim)]",
  validated:        "text-[var(--color-accent-green)]",
  needs_validation: "text-[var(--color-accent-amber)]",
};

export function AgentStackOverview() {
  return (
    <section className="border-b border-[var(--color-border-default)] px-6 py-6">
      <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.18em] uppercase mb-4">
        Agent Stack
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-[1px] bg-[var(--color-border-default)]">
        {AGENTS.map((agent) => (
          <div
            key={agent.id}
            className="bg-[var(--color-surface-card)] px-4 py-4"
          >
            {/* ID + name + live status dot */}
            <div className="flex items-center gap-3 mb-3">
              <span className="text-[10px] text-[var(--color-accent-blue)] font-medium tracking-[.08em] min-w-[24px]">
                {agent.id}
              </span>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${dotColor[agent.status]}`} />
                <p className="text-[12px] text-[var(--color-text-primary)] font-medium truncate">
                  {agent.name}
                </p>
              </div>
              {/* Status label — driven by agent.status, not hardcoded */}
              <span className={`text-[8px] tracking-[.1em] uppercase shrink-0 ${statusTextColor[agent.status]}`}>
                {statusLabel[agent.status]}
              </span>
            </div>

            <p className="text-[10px] text-[var(--color-text-secondary)] leading-[1.55] mb-2">
              {agent.description}
            </p>

            <div className="pt-2 border-t border-[var(--color-border-subtle)]">
              <span className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">Purpose · </span>
              <span className="text-[9px] text-[var(--color-text-muted)]">{agent.purpose}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
