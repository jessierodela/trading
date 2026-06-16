import * as React from "react";
import type { PaperPosition } from "@/lib/execution";
import {
  formatPaperCurrency,
  formatPaperNumber,
  formatPaperTimestamp,
  metadataText,
  PAPER_TRADING_ONLY_LABEL,
} from "@/lib/dashboard/paperTrading";

export function ClosedTradesTable({ positions }: { positions: PaperPosition[] }) {
  return (
    <div className="bg-[var(--color-surface-card)] border border-[var(--color-border-default)] rounded">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.12em] uppercase">
          Closed Paper Trades
        </p>
        <span className="text-[8px] text-[var(--color-accent-amber)] tracking-[.12em] uppercase">
          {PAPER_TRADING_ONLY_LABEL}
        </span>
      </div>
      {positions.length === 0 ? (
        <p className="px-4 py-5 text-[10px] text-[var(--color-text-muted)]">
          No closed paper trades are currently persisted.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="text-[8px] uppercase tracking-[.1em] text-[var(--color-text-dim)]">
              <tr>
                {["Symbol", "Direction", "Quantity", "Entry", "Exit", "Realized", "Fees", "Close Reason", "Opened", "Closed", "Strategy", "Risk"].map((heading) => (
                  <th key={heading} className="px-3 py-2 font-normal border-b border-[var(--color-border-subtle)]">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <tr key={position.id ?? position.orderId} className="text-[10px] text-[var(--color-text-secondary)]">
                  <td className="px-3 py-2 font-medium text-[var(--color-text-primary)]">{position.symbol}</td>
                  <td className="px-3 py-2">{position.direction}</td>
                  <td className="px-3 py-2 font-mono">{formatPaperNumber(position.quantity)}</td>
                  <td className="px-3 py-2 font-mono">{formatPaperCurrency(position.entryPrice)}</td>
                  <td className="px-3 py-2 font-mono">{formatPaperCurrency(position.exitPrice)}</td>
                  <td className={`px-3 py-2 font-mono ${(position.realizedPnl ?? 0) >= 0 ? "text-[var(--color-accent-green)]" : "text-[var(--color-accent-red)]"}`}>
                    {formatPaperCurrency(position.realizedPnl)}
                  </td>
                  <td className="px-3 py-2 font-mono">{formatPaperCurrency(position.fees)}</td>
                  <td className="px-3 py-2">{metadataText(position.metadata, "closeReason")}</td>
                  <td className="px-3 py-2 font-mono">{formatPaperTimestamp(position.openedAt)}</td>
                  <td className="px-3 py-2 font-mono">{formatPaperTimestamp(position.closedAt)}</td>
                  <td className="px-3 py-2">{metadataText(position.metadata, "strategyId")}</td>
                  <td className="px-3 py-2">{metadataText(position.metadata, "riskVersion")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
