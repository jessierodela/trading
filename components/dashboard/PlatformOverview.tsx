// components/dashboard/PlatformOverview.tsx
// Section 1 — plain-English description of what the platform currently does
// and what stage it is in. This copy describes design intent and code-level
// facts (what is wired, what is blocked); live run state is shown by the
// System State console below it.

import { Pulse } from "@/components/ui/Pulse";

const PHASES = [
  { label: "Research", status: "done", note: "P2–P6 feature, backtest, and router research" },
  { label: "Data Pipeline", status: "active", note: "hourly scheduled ingest → features → regime" },
  { label: "Strategy Evaluation", status: "active", note: "deterministic rules, scheduled hourly" },
  { label: "Risk Gate", status: "active", note: "deterministic engine on every scheduled signal" },
  { label: "Paper Monitoring", status: "active", note: "simulated positions, no broker" },
  { label: "Live Execution", status: "disabled", note: "blocked in code, no broker integration" },
] as const;

const phaseTone: Record<(typeof PHASES)[number]["status"], string> = {
  done: "border-[var(--color-accent-green)]/40 text-[var(--color-accent-green)]",
  active: "border-[var(--color-accent-blue)]/40 text-[var(--color-accent-blue)]",
  disabled: "border-[var(--color-accent-red)]/40 text-[var(--color-accent-red)]",
};

export function PlatformOverview() {
  return (
    <section className="border-b border-[var(--color-border-default)] px-4 py-7 sm:px-6">
      <div className="flex items-start gap-3">
        <Pulse />
        <div className="min-w-0">
          <p className="mb-2 text-[9px] uppercase tracking-[.18em] text-[var(--color-text-dim)]">
            Section 1 · Platform Overview
          </p>
          <h1 className="text-[20px] font-light leading-tight tracking-tight text-[var(--color-text-primary)]">
            Trading Intelligence Platform — Operations Dashboard
          </h1>
          <p className="mt-3 max-w-[720px] text-[12px] leading-[1.7] text-[var(--color-text-secondary)]">
            This platform ingests BTC-USD market data on an hourly schedule, computes
            deterministic feature snapshots, classifies the market regime, evaluates strategy
            rules against that context, applies a deterministic risk gate to every signal, and
            monitors the approved ones as simulated paper positions. Live execution is not
            enabled — it is rejected in code and no broker integration exists.
          </p>
          <p className="mt-2 max-w-[720px] text-[10px] leading-[1.6] text-[var(--color-text-muted)]">
            This dashboard is read-only. It explains what the system is, what is currently
            running, what is stale or blocked, and what still needs engineering work — it is
            not a trading terminal.
          </p>
        </div>
      </div>

      {/* Phase chips */}
      <div className="mt-5 flex flex-wrap gap-2">
        {PHASES.map((phase) => (
          <span
            key={phase.label}
            title={phase.note}
            className={`rounded-full border px-[10px] py-[4px] text-[9px] uppercase tracking-[.1em] ${phaseTone[phase.status]}`}
          >
            {phase.label}: {phase.status}
          </span>
        ))}
      </div>
    </section>
  );
}
