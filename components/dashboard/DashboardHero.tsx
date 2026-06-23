// components/dashboard/DashboardHero.tsx
// First impression: architecture & intelligence dashboard, not a trading terminal.

import { Pulse } from "@/components/ui/Pulse";

const STATUS_CHIPS = [
  { label: "Durable Jobs",          color: "green" },
  { label: "Persisted State",       color: "blue"  },
  { label: "Scheduled Pipeline",    color: "blue"  },
  { label: "Paper Only",            color: "amber" },
  { label: "Live Execution Off",    color: "red"   },
] as const;

const chipColor = {
  green: "text-[var(--color-accent-green)] border-[var(--color-accent-green)]",
  blue:  "text-[var(--color-accent-blue)]  border-[var(--color-accent-blue)]",
  amber: "text-[var(--color-accent-amber)] border-[var(--color-accent-amber)]",
  red:   "text-[var(--color-accent-red)]   border-[var(--color-accent-red)]",
};

export function DashboardHero() {
  return (
    <div className="border-b border-[var(--color-border-default)] px-6 py-8">
      <div className="flex items-start gap-3 mb-3">
        <Pulse />
        <div>
          <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.18em] mb-2 uppercase">
            Scheduler, workers, pipelines, and persisted state
          </p>
          <h1 className="text-[22px] font-light text-[var(--color-text-primary)] tracking-tight leading-tight">
            AI Trading Operations
          </h1>
          <p className="text-[12px] text-[var(--color-text-muted)] mt-2 max-w-[680px] leading-[1.65]">
            Observe the durable data pipeline from hourly scheduling through worker processing,
            persisted snapshots, and the signal consumers that power this dashboard.
          </p>
        </div>
      </div>

      {/* Status chips */}
      <div className="flex flex-wrap gap-2 mt-5">
        {STATUS_CHIPS.map((chip) => (
          <span
            key={chip.label}
            className={`text-[9px] tracking-[.12em] px-[10px] py-[4px] border rounded-full uppercase opacity-80 ${chipColor[chip.color]}`}
          >
            {chip.label}
          </span>
        ))}
      </div>

      {/* System state row */}
      <div className="flex flex-wrap gap-6 mt-5 pt-4 border-t border-[var(--color-border-subtle)]">
        <div>
          <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.1em]">CURRENT MODE </span>
          <span className="text-[9px] text-[var(--color-accent-blue)] tracking-[.1em]">Operations + Validation</span>
        </div>
        <div>
          <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.1em]">EXECUTION BOUNDARY </span>
          <span className="text-[9px] text-[var(--color-accent-amber)] tracking-[.1em]">Signals and paper monitoring only</span>
        </div>
      </div>
    </div>
  );
}
