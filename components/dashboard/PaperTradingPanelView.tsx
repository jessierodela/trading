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
    ? "text-[var(--color-accent-green)] border-[var(--color-accent-green)]/40 bg-[var(--color-accent-green)]/5"
    : data.state === "error"
      ? "text-[var(--color-accent-red)] border-[var(--color-accent-red)]/40 bg-[var(--color-accent-red)]/5"
      : "text-[var(--color-accent-amber)] border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/5";

  return (
    <section className="px-5 py-8 sm:px-10">
      <p className="mb-1 text-[11px] uppercase tracking-[.16em] text-[var(--color-text-dim)]">
        04 &middot; Paper P&amp;L
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[24px] font-semibold tracking-normal text-[var(--color-text-primary)]">
          Simulated performance
        </h2>
        <span className="rounded-full border border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[.08em] text-[var(--color-accent-amber)]">
          Paper trading only
        </span>
      </div>
      <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">
        Every figure is simulated. Nothing here touches a real account.
      </p>

      <div className="mt-6 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-surface-card)] px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] leading-[1.55] text-[var(--color-text-secondary)]">{data.statusMessage}</p>
          <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.06em] ${stateTone}`}>
            {data.state}
          </span>
        </div>
        {data.loadedAt ? (
          <p className="mt-2 font-mono text-[11px] text-[var(--color-text-dim)]">
            Loaded at {data.loadedAt}
          </p>
        ) : null}
        <p className="mt-2 text-[11px] uppercase tracking-[.1em] text-[var(--color-accent-amber)]">
          {PAPER_TRADING_ONLY_LABEL}
        </p>
      </div>

      <div className="mt-6 space-y-5">
        <PaperPnlSummary summary={data.summary} />
        <OpenPositionsTable positions={data.openPositions} />
        <ClosedTradesTable positions={data.closedPositions} />
        <PaperRiskLineagePanel positions={allPositions} />
      </div>
    </section>
  );
}
