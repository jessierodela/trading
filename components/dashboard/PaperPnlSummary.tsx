import * as React from "react";
import {
  formatPaperCurrency,
  formatPaperPercent,
  type PaperPnlSummary,
} from "@/lib/dashboard/paperTrading";

const toneClass = {
  green: "text-[var(--color-accent-green)]",
  red: "text-[var(--color-accent-red)]",
  amber: "text-[var(--color-accent-amber)]",
  blue: "text-[var(--color-accent-blue)]",
  muted: "text-[var(--color-text-primary)]",
};

export function PaperPnlSummary({ summary }: { summary: PaperPnlSummary }) {
  const netPnl = summary.totalRealizedPnl + summary.totalUnrealizedPnl;
  const metrics = [
    { label: "Realized PnL", value: formatPaperCurrency(summary.totalRealizedPnl), tone: summary.totalRealizedPnl >= 0 ? "green" : "red" },
    { label: "Unrealized PnL", value: formatPaperCurrency(summary.totalUnrealizedPnl), tone: summary.totalUnrealizedPnl >= 0 ? "green" : "red" },
    { label: "Total Fees", value: formatPaperCurrency(summary.totalFees), tone: "muted" },
    { label: "Win Rate", value: formatPaperPercent(summary.winRatePct), tone: "blue" },
    { label: "Win / Loss", value: `${summary.winCount} / ${summary.lossCount}`, tone: "muted" },
    { label: "Max Drawdown", value: formatPaperCurrency(summary.maxDrawdown === null ? null : -Math.abs(summary.maxDrawdown)), tone: "amber" },
    { label: "Open Exposure", value: formatPaperCurrency(summary.openExposure), tone: "blue" },
    { label: "Closed Trades", value: String(summary.closedTradeCount), tone: "muted" },
    { label: "Net PnL", value: formatPaperCurrency(netPnl), tone: netPnl >= 0 ? "green" : "red" },
  ] as const;

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {metrics.map((metric) => (
        <div key={metric.label} className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-surface-card)] px-5 py-[18px]">
          <p className="mb-3 text-[11px] uppercase tracking-[.08em] text-[var(--color-text-muted)]">{metric.label}</p>
          <p className={`text-[22px] font-light tabular-nums ${toneClass[metric.tone]}`}>{metric.value}</p>
        </div>
      ))}
    </div>
  );
}
