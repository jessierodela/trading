// components/dashboard/StrategyResearchPanel.tsx
// P5 strategy research — research status only, not live trade recommendations.

import { STRATEGY_RESEARCH } from "@/lib/dashboard/dashboardArchitecture";

export function StrategyResearchPanel() {
  return (
    <section className="border-b border-[var(--color-border-default)] px-6 py-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.18em] uppercase mb-1">
            Strategy Research
          </p>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            P5 strategy candidate evaluation — research status, not live recommendations.
          </p>
        </div>
        <span className="text-[9px] text-[var(--color-accent-blue)] tracking-[.1em] border border-[var(--color-accent-blue)] px-[10px] py-[4px] rounded-full uppercase opacity-80 shrink-0">
          Research Mode
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-[1px] bg-[var(--color-border-default)]">
        {STRATEGY_RESEARCH.map((s) => (
          <div key={s.name} className="bg-[var(--color-surface-card)] px-4 py-4">
            <p className="text-[12px] text-[var(--color-text-primary)] font-medium mb-1">
              {s.name}
            </p>
            <p className="text-[10px] text-[var(--color-text-secondary)] mb-3 leading-[1.5]">
              {s.currentRead}
            </p>

            {/* Promising in */}
            <div className="mb-3">
              <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase mb-2">Promising In</p>
              <div className="flex flex-wrap gap-1">
                {s.promisingIn.map((regime) => (
                  <span
                    key={regime}
                    className="text-[8px] text-[var(--color-accent-green)] border border-[var(--color-accent-green)] px-2 py-[2px] rounded-full tracking-[.08em]"
                  >
                    {regime}
                  </span>
                ))}
              </div>
            </div>

            {/* Investigate */}
            <div className="pt-2 border-t border-[var(--color-border-subtle)]">
              <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase mb-2">Investigate</p>
              <ul className="space-y-[3px]">
                {s.investigate.map((item) => (
                  <li key={item} className="text-[9px] text-[var(--color-text-muted)] leading-[1.45]">
                    · {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
