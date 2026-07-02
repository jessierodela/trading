// components/dashboard/HowToReadPanel.tsx
// Static trust rules for reading the command console.

const TRUST_RULES: Array<{ term: string; meaning: string }> = [
  { term: "Read-only", meaning: "No order entry, no broker actions, no live trading. This console explains system state; it does not operate the system." },
  { term: "Gray is not green", meaning: "A gray or unknown stage means its state could not be determined, not that it is fine." },
  { term: "Real vs mocked", meaning: "Every live section declares whether its data is real, stale, simulated, unavailable, or disabled." },
  { term: "Paper only", meaning: "All positions and PnL are simulated. Paper fills and fees are persisted for research visibility only." },
  { term: "Deterministic", meaning: "Strategy rules and the risk gate are deterministic. They are not model guesses or manually written status claims." },
];

export function HowToReadPanel() {
  return (
    <section className="px-5 py-8 sm:px-10">
      <p className="mb-1 text-[11px] uppercase tracking-[.16em] text-[var(--color-text-dim)]">
        05 &middot; Glossary
      </p>
      <h2 className="text-[24px] font-semibold tracking-normal text-[var(--color-text-primary)]">
        How to read this console
      </h2>
      <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">
        The trust rules this dashboard holds itself to.
      </p>

      <dl className="mt-6 overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-border-default)]">
        {TRUST_RULES.map((row) => (
          <div key={row.term} className="flex flex-col gap-3 bg-[var(--color-surface-card)] px-5 py-[18px] sm:flex-row sm:gap-[22px] [&+&]:mt-px">
            <dt className="w-[150px] shrink-0 text-[15px] font-semibold text-[var(--color-text-primary)]">{row.term}</dt>
            <dd className="flex-1 text-[14px] leading-[1.55] text-[var(--color-text-muted)]">{row.meaning}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
