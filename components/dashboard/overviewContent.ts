export const PLATFORM_DESCRIPTION =
  "This platform ingests BTC-USD market data on an hourly schedule, computes deterministic feature snapshots, classifies the market regime, evaluates strategy rules against that context, applies a deterministic risk gate to every signal, and monitors the approved ones as simulated paper positions. Live execution is not enabled; it is rejected in code and no broker integration exists.";

export const PLATFORM_READ_ONLY_NOTE =
  "This dashboard is read-only. It explains what the system is, what is currently running, what is stale or blocked, and what still needs engineering work. It is not a trading terminal.";

export const PHASES = [
  { label: "Research", status: "done", note: "P2-P6 feature, backtest, and router research" },
  { label: "Data Pipeline", status: "active", note: "hourly scheduled ingest to features to regime" },
  { label: "Strategy Evaluation", status: "active", note: "deterministic rules, scheduled hourly" },
  { label: "Risk Gate", status: "active", note: "deterministic engine on every scheduled signal" },
  { label: "Paper Monitoring", status: "active", note: "simulated positions, no broker" },
  { label: "Live Execution", status: "disabled", note: "blocked in code, no broker integration" },
] as const;

export const phaseTone: Record<(typeof PHASES)[number]["status"], string> = {
  done: "border-[var(--color-accent-green)]/40 text-[var(--color-accent-green)] bg-[var(--color-accent-green)]/5",
  active: "border-[var(--color-accent-blue)]/40 text-[var(--color-accent-blue)] bg-[var(--color-accent-blue)]/5",
  disabled: "border-[var(--color-accent-red)]/40 text-[var(--color-accent-red)] bg-[var(--color-accent-red)]/5",
};
