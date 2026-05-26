// components/dashboard/DataHealthPanel.tsx
// Platform operations / data infrastructure health.
// Values marked "—" are placeholders — wire to live endpoints when ready.

import { DATA_HEALTH, type StatusState } from "@/lib/dashboard/dashboardArchitecture";

const statusColor: Record<StatusState, string> = {
  active:           "text-[var(--color-accent-green)]",
  in_progress:      "text-[var(--color-accent-blue)]",
  pending:          "text-[var(--color-accent-amber)]",
  disabled:         "text-[var(--color-accent-red)]",
  planned:          "text-[var(--color-text-dim)]",
  validated:        "text-[var(--color-accent-green)]",
  needs_validation: "text-[var(--color-accent-amber)]",
};

export function DataHealthPanel() {
  return (
    <section className="border-b border-[var(--color-border-default)] px-6 py-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.18em] uppercase mb-1">
            Data Health
          </p>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            Infrastructure reliability and data readiness. Values marked &ldquo;—&rdquo; are pending live wiring.
          </p>
        </div>
      </div>

      <div
        className="grid grid-cols-2 md:grid-cols-5 gap-[1px] bg-[var(--color-border-default)]"
      >
        {DATA_HEALTH.map((metric) => (
          <div key={metric.label} className="bg-[var(--color-surface-card)] px-4 py-4">
            <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase mb-2 leading-[1.4]">
              {metric.label}
            </p>
            <p className={`text-[15px] font-light mb-1 ${statusColor[metric.status]}`}>
              {metric.value}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
