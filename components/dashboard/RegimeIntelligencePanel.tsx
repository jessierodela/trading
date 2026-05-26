// components/dashboard/RegimeIntelligencePanel.tsx
// A6 regime layer — core architectural component.

import { REGIMES } from "@/lib/dashboard/dashboardArchitecture";

const regimeColor: Record<string, string> = {
  TREND_UP:    "text-[var(--color-accent-green)]  border-[var(--color-accent-green)]",
  TREND_DOWN:  "text-[var(--color-accent-red)]    border-[var(--color-accent-red)]",
  LOW_VOL:     "text-[var(--color-accent-blue)]   border-[var(--color-accent-blue)]",
  HIGH_VOL:    "text-[var(--color-accent-amber)]  border-[var(--color-accent-amber)]",
  CHOP:        "text-[var(--color-text-muted)]    border-[var(--color-border-default)]",
  NEWS_SHOCK:  "text-[var(--color-accent-red)]    border-[var(--color-accent-red)]",
};

export function RegimeIntelligencePanel() {
  return (
    <section className="border-b border-[var(--color-border-default)] px-6 py-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.18em] uppercase mb-1">
            Regime Intelligence
          </p>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            A6 regime detector classifies the market environment before strategy evaluation.
          </p>
        </div>
        <span className="text-[9px] text-[var(--color-accent-blue)] tracking-[.1em] border border-[var(--color-accent-blue)] px-[10px] py-[4px] rounded-full uppercase opacity-80 shrink-0">
          A6 Active
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-[1px] bg-[var(--color-border-default)]">
        {REGIMES.map((r) => (
          <div key={r.regime} className="bg-[var(--color-surface-card)] px-4 py-4">
            {/* Regime name chip */}
            <div className="mb-3">
              <span
                className={`text-[9px] tracking-[.12em] px-[10px] py-[3px] border rounded-full uppercase font-medium ${regimeColor[r.regime] ?? "text-[var(--color-text-muted)] border-[var(--color-border-default)]"}`}
              >
                {r.regime}
              </span>
            </div>

            <p className="text-[10px] text-[var(--color-text-secondary)] leading-[1.55] mb-3">
              {r.description}
            </p>

            <div className="mb-2">
              <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase mb-[3px]">Strategy Implication</p>
              <p className="text-[9px] text-[var(--color-text-muted)] leading-[1.5]">{r.strategyImplication}</p>
            </div>

            <div className="pt-2 border-t border-[var(--color-border-subtle)]">
              <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase mb-[3px]">Research Status</p>
              <p className="text-[9px] text-[var(--color-text-muted)]">{r.researchStatus}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
