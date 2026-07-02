"use client";

import { useEffect, useState } from "react";
import { Pulse } from "@/components/ui/Pulse";

const ASSETS = [
  { label: "S&P 500", symbol: "^GSPC", type: "stock" },
  { label: "NASDAQ", symbol: "^IXIC", type: "stock" },
  { label: "BTC", symbol: "BTC", type: "crypto" },
  { label: "VIX", symbol: "^VIX", type: "stock" },
] as const;

interface TickerState {
  label: string;
  value: string;
  change: string;
  up: boolean;
}

const EMPTY: TickerState[] = ASSETS.map((a) => ({
  label: a.label,
  value: "-",
  change: "-",
  up: true,
}));

export function Header() {
  const [time, setTime] = useState("");
  const [tickers, setTickers] = useState<TickerState[]>(EMPTY);

  useEffect(() => {
    const tick = () => {
      setTime(
        `${new Date().toLocaleTimeString("en-US", {
          hour12: false,
          timeZone: "America/Chicago",
        })} CT`,
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const params = ASSETS.map((a) => `${a.symbol}:${a.type}`).join(",");
        const res = await fetch(`/api/quotes?assets=${encodeURIComponent(params)}`);
        if (!res.ok) return;
        const data: Record<string, { price: string; change: string; up: boolean }> = await res.json();
        if (cancelled) return;

        setTickers(
          ASSETS.map((a) => {
            const q = data[a.symbol];
            if (!q) return { label: a.label, value: "-", change: "-", up: true };
            return { label: a.label, value: q.price, change: q.change, up: q.up };
          }),
        );
      } catch {
        // Keep previous values on error.
      }
    };

    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <header className="flex h-[60px] shrink-0 items-center justify-between gap-5 border-b border-[var(--color-border-default)] bg-[var(--color-surface-panel)] px-5 sm:px-[26px]">
      <div className="flex shrink-0 items-center gap-4">
        <Pulse />
        <span className="whitespace-nowrap text-[13px] font-semibold tracking-[.16em] text-[var(--color-text-primary)]">
          MARKET INTELLIGENCE
        </span>
        <span className="hidden border-l border-[var(--color-border-default)] pl-4 text-[11px] tracking-[.1em] text-[var(--color-text-dim)] sm:inline">
          RESEARCH CONSOLE
        </span>
      </div>

      <div className="hidden min-w-0 flex-1 items-center justify-end gap-4 xl:flex">
        <span className="shrink-0 border-r border-[var(--color-border-default)] pr-5 text-[10px] tracking-[.12em] text-[var(--color-text-dim)]">
          DATA CONTEXT &middot; DISPLAY ONLY
        </span>
        {tickers.map((ticker) => (
          <div key={ticker.label} className="flex shrink-0 items-baseline gap-2 whitespace-nowrap">
            <span className="text-[10px] tracking-[.06em] text-[var(--color-text-dim)]">{ticker.label}</span>
            <span className="text-[12px] tabular-nums text-[var(--color-text-secondary)]">{ticker.value}</span>
            <span className={`text-[11px] ${ticker.up ? "text-[var(--color-accent-green)]" : "text-[var(--color-accent-red)]"}`}>
              {ticker.change}
            </span>
          </div>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-4">
        <span className="hidden items-center gap-2 border-l border-[var(--color-border-default)] pl-5 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-red)] animate-pulse-amber" />
          <span className="text-[11px] text-[var(--color-text-secondary)]">Execution disabled</span>
        </span>

        <span className="border-l border-[var(--color-border-default)] pl-4 text-[12px] tabular-nums text-[var(--color-text-muted)]">
          {time}
        </span>
      </div>
    </header>
  );
}
