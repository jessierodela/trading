// components/dashboard/AgentStackOverview.tsx
// Intelligence layers shown as agents, not trade widgets.

import { AGENTS } from "@/lib/dashboard/dashboardArchitecture";

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
            <div className="flex items-center gap-3 mb-3">
              <span className="text-[10px] text-[var(--color-accent-blue)] font-medium tracking-[.08em] min-w-[24px]">
                {agent.id}
              </span>
              <div className="flex items-center gap-2">
                <span className="w-[5px] h-[5px] rounded-full bg-[var(--color-accent-green)] animate-pulse-dot shrink-0" />
                <p className="text-[12px] text-[var(--color-text-primary)] font-medium">
                  {agent.name}
                </p>
              </div>
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
