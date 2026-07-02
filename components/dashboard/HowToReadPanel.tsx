// components/dashboard/HowToReadPanel.tsx
// Section 9 — explains the pipeline stages, the status vocabulary, and which
// parts of this dashboard can be trusted. Intentionally static documentation.

const STAGE_GLOSSARY: Array<{ term: string; meaning: string }> = [
  { term: "Market Data Ingest", meaning: "Fetches closed hourly BTC-USD candles from Coinbase REST and persists them. Nothing is predicted here — it is raw price history." },
  { term: "Feature Snapshots", meaning: "Turns persisted candles into indicator values (RSI, MACD, EMAs, ATR, volume ratios). Deterministic math, versioned, replayable." },
  { term: "Regime Compute", meaning: "Classifies the market environment (TREND_UP, CHOP, HIGH_VOL, …) from persisted features. The scheduled path is deterministic — no LLM." },
  { term: "Strategy Evaluation", meaning: "Runs rule-based strategies over feature windows plus regime context and persists any signals. Signals are research output, not orders." },
  { term: "Risk Gate", meaning: "Every scheduled signal is approved, resized, or blocked by a deterministic risk engine before it can become a paper trade intent." },
  { term: "Paper Monitor", meaning: "Tracks approved intents as simulated positions with simulated fills. No money moves anywhere." },
  { term: "Dashboard Snapshots", meaning: "Persists the display payload that this dashboard and /api/signals read, with an expiry so staleness is detectable." },
  { term: "Alerts / Reports", meaning: "Outbound notifications. Currently disabled — the job type exists but nothing schedules it." },
];

const STATUS_GLOSSARY: Array<{ term: string; meaning: string }> = [
  { term: "healthy", meaning: "The last run succeeded recently enough for an hourly pipeline (within 2 hours)." },
  { term: "warning", meaning: "Something is off but not failing — e.g. work is queued and waiting, or a run was cancelled." },
  { term: "stale", meaning: "Data exists but is older than expected. It was real when written; treat it as outdated now." },
  { term: "blocked", meaning: "The latest run failed or was dead-lettered after exhausting retries. Needs investigation." },
  { term: "disabled", meaning: "Intentionally off. Not an error — the platform is built this way on purpose (e.g. live execution)." },
  { term: "unknown", meaning: "The state could not be determined, and the reason is shown. Unknown is never rendered as green." },
  { term: "static", meaning: "Hand-written content describing design or research findings. It does not read live state and does not update on its own." },
];

export function HowToReadPanel() {
  return (
    <section className="border-b border-[var(--color-border-default)] px-4 py-6 sm:px-6">
      <p className="text-[9px] uppercase tracking-[.18em] text-[var(--color-text-dim)]">
        Section 9 · How to Read This Dashboard
      </p>
      <p className="mt-2 max-w-[720px] text-[11px] leading-[1.65] text-[var(--color-text-muted)]">
        Trust rules: anything under <span className="text-[var(--color-text-secondary)]">System State</span> is
        read live from the database on every poll and shows its own source of truth. Anything
        labeled <span className="text-[var(--color-text-secondary)]">static reference</span> is documentation —
        useful for understanding the design, but it proves nothing about the current run state.
        When the two disagree, believe the live panels.
      </p>

      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-[8px] uppercase tracking-[.12em] text-[var(--color-text-dim)]">
            Pipeline stages
          </p>
          <dl className="space-y-2">
            {STAGE_GLOSSARY.map((row) => (
              <div key={row.term} className="border-b border-[var(--color-border-subtle)] pb-2">
                <dt className="text-[10px] font-medium text-[var(--color-text-primary)]">{row.term}</dt>
                <dd className="mt-0.5 text-[9px] leading-[1.55] text-[var(--color-text-muted)]">{row.meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <p className="mb-2 text-[8px] uppercase tracking-[.12em] text-[var(--color-text-dim)]">
            Status vocabulary
          </p>
          <dl className="space-y-2">
            {STATUS_GLOSSARY.map((row) => (
              <div key={row.term} className="border-b border-[var(--color-border-subtle)] pb-2">
                <dt className="font-mono text-[10px] font-medium text-[var(--color-text-primary)]">{row.term}</dt>
                <dd className="mt-0.5 text-[9px] leading-[1.55] text-[var(--color-text-muted)]">{row.meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
