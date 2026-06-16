import * as React from "react";
import { ClosedTradesTable } from "./ClosedTradesTable";
import { OpenPositionsTable } from "./OpenPositionsTable";
import { PaperPnlSummary } from "./PaperPnlSummary";
import { PaperRiskLineagePanel } from "./PaperRiskLineagePanel";
import {
  PAPER_TRADING_ONLY_LABEL,
  type PaperTradingDashboardData,
} from "@/lib/dashboard/paperTrading";

export function PaperTradingPanelView({ data }: { data: PaperTradingDashboardData }) {
  const allPositions = [...data.openPositions, ...data.closedPositions];
  const stateTone = data.state === "ready"
    ? "text-[var(--color-accent-green)] border-[var(--color-accent-green)]"
    : data.state === "error"
      ? "text-[var(--color-accent-red)] border-[var(--color-accent-red)]"
      : "text-[var(--color-accent-amber)] border-[var(--color-accent-amber)]";

  return (
    <section className="border-b border-[var(--color-border-default)] px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div>
          <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.18em] uppercase mb-1">
            Paper Trading
          </p>
          <h2 className="text-[16px] font-light text-[var(--color-text-primary)] mb-2">
            Paper positions, closed trades, PnL, and lineage
          </h2>
          <p className="text-[11px] text-[var(--color-text-muted)] leading-[1.6] max-w-[780px]">
            Read-only visibility for the paper trading workflow. This panel does not place,
            close, or route live orders.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[8px] tracking-[.12em] uppercase px-[9px] py-[3px] rounded-full border border-[var(--color-accent-amber)] text-[var(--color-accent-amber)]">
            {PAPER_TRADING_ONLY_LABEL}
          </span>
          <span className={`text-[8px] tracking-[.12em] uppercase px-[9px] py-[3px] rounded-full border ${stateTone}`}>
            {data.state}
          </span>
        </div>
      </div>

      <div className="bg-[var(--color-surface-card)] border border-[var(--color-border-default)] rounded px-4 py-3 mb-5">
        <p className="text-[10px] text-[var(--color-text-secondary)] leading-[1.55]">
          {data.statusMessage}
        </p>
        {data.loadedAt ? (
          <p className="text-[8px] text-[var(--color-text-dim)] mt-1 font-mono">
            Loaded at {data.loadedAt}
          </p>
        ) : null}
      </div>

      <div className="space-y-5">
        <PaperPnlSummary summary={data.summary} />
        <OpenPositionsTable positions={data.openPositions} />
        <ClosedTradesTable positions={data.closedPositions} />
        <PaperRiskLineagePanel positions={allPositions} />
      </div>
    </section>
  );
}

