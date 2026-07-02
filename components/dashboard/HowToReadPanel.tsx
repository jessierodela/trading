"use client";

// components/dashboard/HowToReadPanel.tsx
// Expandable glossary groups for reading the command console.

import { useState } from "react";

type GlossaryGroupKey = "pipeline" | "status" | "trust";

interface GlossaryRow {
  term: string;
  meaning: string;
}

interface GlossaryGroup {
  key: GlossaryGroupKey;
  title: string;
  summary: string;
  rows: GlossaryRow[];
}

const PIPELINE_DEFINITIONS: GlossaryRow[] = [
  { term: "Market Data Ingest", meaning: "Fetches closed BTC-USD candles and persists raw market bars." },
  { term: "Feature Snapshots", meaning: "Computes deterministic indicators from persisted bars." },
  { term: "Regime Classification", meaning: "Classifies the market environment from feature snapshots." },
  { term: "Strategy Evaluation", meaning: "Runs deterministic strategy rules against feature windows and regime context." },
  { term: "Risk Gate", meaning: "Approves, blocks, or resizes scheduled strategy signals before paper intent." },
  { term: "Paper Monitoring", meaning: "Tracks simulated paper positions, fills, and PnL. It is not brokerage execution." },
  { term: "Dashboard Snapshots", meaning: "Persists the display payload consumed by /api/signals." },
  { term: "Alerts / Reports", meaning: "Represents outbound reporting capability. It remains visible even when disabled." },
  { term: "Live Execution", meaning: "Represents broker/live execution, which is intentionally disabled in this codebase." },
];

const STATUS_VOCABULARY: GlossaryRow[] = [
  { term: "Healthy", meaning: "The latest available signal is current enough to trust at face value." },
  { term: "Warning", meaning: "The stage is wired, but the dashboard found a condition that needs review." },
  { term: "Stale", meaning: "The stage has real data, but the latest success is older than the expected freshness window." },
  { term: "Blocked", meaning: "The stage cannot currently complete successfully." },
  { term: "Disabled", meaning: "The capability is intentionally unavailable in this environment or code path." },
  { term: "Unknown", meaning: "The dashboard could not determine the state from available system data." },
  { term: "Real data", meaning: "The section is backed by persisted or live system data." },
  { term: "Unavailable", meaning: "The expected data is missing or could not be read." },
  { term: "Display only", meaning: "The value is context for the operator and is not used for execution." },
];

const TRUST_RULES: GlossaryRow[] = [
  { term: "Read-only", meaning: "No order entry, no broker actions, no live trading. This console explains system state; it does not operate the system." },
  { term: "Gray is not green", meaning: "A gray or unknown stage means its state could not be determined, not that it is fine." },
  { term: "Real vs mocked", meaning: "Every live section declares whether its data is real, stale, simulated, unavailable, or disabled." },
  { term: "Paper only", meaning: "All positions and PnL are simulated. Paper fills and fees are persisted for research visibility only." },
  { term: "Deterministic", meaning: "Strategy rules and the risk gate are deterministic. They are not model guesses or manually written status claims." },
];

const GLOSSARY_GROUPS: GlossaryGroup[] = [
  {
    key: "pipeline",
    title: "Pipeline stage definitions",
    summary: "What each module in the system flow is responsible for.",
    rows: PIPELINE_DEFINITIONS,
  },
  {
    key: "status",
    title: "Status vocabulary",
    summary: "How to interpret healthy, stale, disabled, unknown, and data-reality labels.",
    rows: STATUS_VOCABULARY,
  },
  {
    key: "trust",
    title: "Trust rules",
    summary: "The safety and honesty rules this dashboard holds itself to.",
    rows: TRUST_RULES,
  },
];

export function HowToReadPanel() {
  const [expandedGroups, setExpandedGroups] = useState<Record<GlossaryGroupKey, boolean>>({
    pipeline: false,
    status: false,
    trust: false,
  });

  return (
    <section className="px-5 py-8 sm:px-10">
      <p className="mb-1 text-[11px] uppercase tracking-[.16em] text-[var(--color-text-dim)]">
        05 &middot; Glossary
      </p>
      <h2 className="text-[24px] font-semibold tracking-normal text-[var(--color-text-primary)]">
        How to read this console
      </h2>
      <p className="mt-2 max-w-[680px] text-[14px] leading-[1.6] text-[var(--color-text-muted)]">
        Open a group when you need context, then collapse it to return to the simple dashboard view.
      </p>

      <div className="mt-6 space-y-3">
        {GLOSSARY_GROUPS.map((group) => {
          const expanded = expandedGroups[group.key];
          const detailsId = `glossary-${group.key}-details`;

          return (
            <article key={group.key} className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-surface-card)] px-5 py-[18px]">
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={() =>
                  setExpandedGroups((current) => ({
                    ...current,
                    [group.key]: !current[group.key],
                  }))
                }
                className="flex w-full flex-wrap items-start justify-between gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-card)]"
              >
                <span className="min-w-0">
                  <span className="block text-[16px] font-semibold text-[var(--color-text-primary)]">{group.title}</span>
                  <span className="mt-1 block text-[13px] leading-[1.5] text-[var(--color-text-muted)]">{group.summary}</span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-2 pt-0.5 text-[12px] font-semibold text-[var(--color-text-muted)]">
                  {expanded ? "Hide details" : "Details"}
                  <span aria-hidden="true" className="text-[14px] leading-none">
                    {expanded ? "-" : "+"}
                  </span>
                </span>
              </button>

              {expanded ? (
                <dl id={detailsId} className="mt-4 overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-border-default)]">
                  {group.rows.map((row) => (
                    <div key={row.term} className="flex flex-col gap-3 bg-[var(--color-surface-panel)] px-4 py-3 sm:flex-row sm:gap-[22px] [&+&]:mt-px">
                      <dt className="w-[170px] shrink-0 text-[14px] font-semibold text-[var(--color-text-primary)]">{row.term}</dt>
                      <dd className="flex-1 text-[13px] leading-[1.55] text-[var(--color-text-muted)]">{row.meaning}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
