import * as React from "react";
import {
  formatPaperCurrency,
  formatPaperPercent,
  PAPER_TRADING_ONLY_LABEL,
  type PaperPnlSummary,
} from "@/lib/dashboard/paperTrading";

const metricClass = "bg-[var(--color-surface-card)] border border-[var(--color-border-subtle)] rounded px-4 py-3";

export function PaperPnlSummary({ summary }: { summary: PaperPnlSummary }) {
  const metrics = [
    { label: "Realized PnL", value: formatPaperCurrency(summary.totalRealizedPnl), tone: summary.totalRealizedPnl >= 0 ? "green" : "red" },
    { label: "Unrealized PnL", value: formatPaperCurrency(summary.totalUnrealizedPnl), tone: summary.totalUnrealizedPnl >= 0 ? "green" : "red" },
    { label: "Total Fees", value: formatPaperCurrency(summary.totalFees), tone: "muted" },
    { label: "Win Count", value: String(summary.winCount), tone: "green" },
    { label: "Loss Count", value: String(summary.lossCount), tone: "red" },
    { label: "Win Rate", value: formatPaperPercent(summary.winRatePct), tone: "blue" },
    { label: "Max Drawdown", value: formatPaperCurrency(summary.maxDrawdown), tone: "amber" },
    { label: "Open Exposure", value: formatPaperCurrency(summary.openExposure), tone: "blue" },
    { label: "Closed Trades", value: String(summary.closedTradeCount), tone: "muted" },
  ] as const;

  const toneClass = {
    green: "text-[var(--color-accent-green)]",
    red: "text-[var(--color-accent-red)]",
    amber: "text-[var(--color-accent-amber)]",
    blue: "text-[var(--color-accent-blue)]",
    muted: "text-[var(--color-text-secondary)]",
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.12em] uppercase">
          PnL Summary
        </p>
        <span className="text-[8px] text-[var(--color-accent-amber)] tracking-[.12em] uppercase">
          {PAPER_TRADING_ONLY_LABEL}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-9 gap-2">
        {metrics.map((metric) => (
          <div key={metric.label} className={metricClass}>
            <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase mb-2">
              {metric.label}
            </p>
            <p className={`text-[14px] font-light ${toneClass[metric.tone]}`}>{metric.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
