// components/dashboard/MultiAssetCoveragePanel.tsx
// Asset coverage — shows honest readiness without overstating validation.

import { ASSET_COVERAGE, type StatusState } from "@/lib/dashboard/dashboardArchitecture";

const statusLabel: Record<StatusState, string> = {
  active:           "Active",
  in_progress:      "In Progress",
  pending:          "Pending",
  disabled:         "Disabled",
  planned:          "Planned",
  validated:        "Validated",
  needs_validation: "Needs Validation",
};

const statusColor: Record<StatusState, string> = {
  active:           "text-[var(--color-accent-green)]",
  in_progress:      "text-[var(--color-accent-blue)]",
  pending:          "text-[var(--color-text-dim)]",
  disabled:         "text-[var(--color-accent-red)]",
  planned:          "text-[var(--color-text-dim)]",
  validated:        "text-[var(--color-accent-green)]",
  needs_validation: "text-[var(--color-accent-amber)]",
};

const COLUMNS = [
  { key: "dataCoverage",      label: "Data" },
  { key: "featureCoverage",   label: "Features" },
  { key: "regimeSnapshots",   label: "Regimes" },
  { key: "strategyResearch",  label: "Research" },
  { key: "backtestReadiness", label: "Backtest" },
] as const;

export function MultiAssetCoveragePanel() {
  return (
    <section className="border-b border-[var(--color-border-default)] px-6 py-6">
      <div className="mb-4">
        <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.18em] uppercase mb-1">
          Multi-Asset Coverage
        </p>
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Initial crypto research set — coverage shown honestly without overstating validation.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead>
            <tr className="border-b border-[var(--color-border-default)]">
              <th className="text-left py-2 pr-4">
                <span className="text-[8px] text-[var(--color-text-dim)] tracking-[.12em] uppercase">Asset</span>
              </th>
              {COLUMNS.map((col) => (
                <th key={col.key} className="text-left py-2 px-3">
                  <span className="text-[8px] text-[var(--color-text-dim)] tracking-[.12em] uppercase">{col.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ASSET_COVERAGE.map((asset) => (
              <tr
                key={asset.symbol}
                className="border-b border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-hover)] transition-colors"
              >
                <td className="py-3 pr-4">
                  <span className="text-[11px] text-[var(--color-text-primary)] font-medium tracking-[.04em]">
                    {asset.symbol}
                  </span>
                </td>
                {COLUMNS.map((col) => {
                  const val = asset[col.key];
                  return (
                    <td key={col.key} className="py-3 px-3">
                      <span className={`text-[9px] tracking-[.06em] ${statusColor[val]}`}>
                        {statusLabel[val]}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
