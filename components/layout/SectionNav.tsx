"use client";

import { useCallback, useEffect, useState } from "react";
import { WATCHLIST } from "@/config/assets";
import { MARKET_POLL_MS } from "@/config/polling";
import type { WatchlistAsset } from "@/types/market";

export type DashboardSection = "overview" | "pipeline" | "attention" | "paper" | "glossary";

const NAV_ITEMS: Array<{ key: DashboardSection; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "pipeline", label: "Pipeline" },
  { key: "attention", label: "Attention" },
  { key: "paper", label: "Paper P&L" },
  { key: "glossary", label: "Glossary" },
];

interface SectionNavProps {
  activeSection: DashboardSection;
  attentionCount: number;
  onSectionChange: (section: DashboardSection) => void;
}

export function SectionNav({ activeSection, attentionCount, onSectionChange }: SectionNavProps) {
  const [marketContext, setMarketContext] = useState<WatchlistAsset[]>(WATCHLIST);

  const fetchMarketContext = useCallback(async () => {
    try {
      const response = await fetch("/api/market");
      if (!response.ok) return;
      const data = (await response.json()) as { quotes?: WatchlistAsset[] };
      if (Array.isArray(data.quotes)) setMarketContext(data.quotes);
    } catch {
      // Preserve the static watchlist fallback.
    }
  }, []);

  useEffect(() => {
    void fetchMarketContext();
    const timer = window.setInterval(() => void fetchMarketContext(), MARKET_POLL_MS);
    return () => window.clearInterval(timer);
  }, [fetchMarketContext]);

  const btc = marketContext.find((asset) => asset.symbol === "BTC");

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-base)] px-3 py-4 md:h-full md:w-[232px] md:border-b-0 md:border-r">
      <p className="px-3 pb-3 pt-1 text-[10px] uppercase tracking-[.16em] text-[var(--color-text-dim)]">
        Sections
      </p>
      <nav aria-label="Dashboard sections" className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
        {NAV_ITEMS.map((item) => {
          const active = item.key === activeSection;
          return (
            <button
              key={item.key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSectionChange(item.key)}
              className={`flex min-h-[42px] min-w-max items-center gap-[11px] rounded-[9px] px-3 py-2.5 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-blue)]/60 md:w-full md:min-w-0 ${
                active ? "bg-[var(--color-surface-hover)]" : "bg-transparent hover:bg-[var(--color-surface-panel)]"
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-[var(--color-accent-blue)]" : "bg-[var(--color-text-dim)]"}`} />
              <span className={`flex-1 text-[13.5px] ${active ? "font-semibold text-[var(--color-text-primary)]" : "font-medium text-[var(--color-text-secondary)]"}`}>
                {item.label}
              </span>
              {item.key === "attention" && attentionCount > 0 ? (
                <span className="rounded-full border border-[var(--color-accent-amber)]/40 bg-[var(--color-accent-amber)]/10 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-amber)]">
                  {attentionCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="mt-4 border-t border-[var(--color-border-subtle)] px-3 pt-4 md:mt-auto">
        <p className="text-[10px] uppercase tracking-[.14em] text-[var(--color-text-dim)]">Primary asset</p>
        <p className="mt-2 font-mono text-[13px] text-[var(--color-text-primary)]">BTC-USD &middot; hourly</p>
        {btc ? (
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            Context {btc.price} <span className={btc.changeUp ? "text-[var(--color-accent-green)]" : "text-[var(--color-accent-red)]"}>{btc.change}</span>
          </p>
        ) : null}
        <p className="mt-2 text-[11px] leading-[1.5] text-[var(--color-text-muted)]">
          Equities are context only. Read-only; no order entry.
        </p>
      </div>
    </aside>
  );
}
