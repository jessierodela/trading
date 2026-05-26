"use client";

import { useEffect, useState } from "react";
import { Pulse } from "@/components/ui/Pulse";

const ASSETS = [
  { label: "S&P 500", symbol: "^GSPC",  type: "stock"  },
  { label: "NASDAQ",  symbol: "^IXIC",  type: "stock"  },
  { label: "BTC",     symbol: "BTC",    type: "crypto" },
  { label: "VIX",     symbol: "^VIX",   type: "stock"  },
] as const;

interface TickerState {
  label: string;
  value: string;
  change: string;
  up: boolean;
}

const EMPTY: TickerState[] = ASSETS.map((a) => ({
  label: a.label,
  value: "—",
  change: "—",
  up: true,
}));

export function Header() {
  const [time, setTime]       = useState("");
  const [tickers, setTickers] = useState<TickerState[]>(EMPTY);

  useEffect(() => {
    const tick = () => {
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour12: false,
          timeZone: "America/Chicago",
        }) + " CT"
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
            if (!q) return { label: a.label, value: "—", change: "—", up: true };
            return { label: a.label, value: q.price, change: q.change, up: q.up };
          })
        );
      } catch {
        // keep previous values on error
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
    <header className="flex items-center justify-between px-5 h-[46px] border-b border-[var(--color-border-default)] bg-[var(--color-surface-panel)] shrink-0 z-10">

      {/* Branding */}
      <div className="flex items-center gap-3">
        <Pulse />
        <span className="text-[13px] font-semibold tracking-[.18em] text-[var(--color-text-primary)]">
          MARKET INTELLIGENCE
        </span>
        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.15em] border-l border-[var(--color-border-default)] pl-3">
          RESEARCH CONSOLE
        </span>
      </div>

      {/* Data context tickers */}
      <div className="hidden md:flex items-center gap-5">
        <span className="text-[8px] text-[var(--color-text-dim)] tracking-[.14em] border-r border-[var(--color-border-default)] pr-5">
          DATA CONTEXT
        </span>
        {tickers.map((t) => (
          <div key={t.label} className="flex gap-2 items-baseline">
            <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.1em]">{t.label}</span>
            <span className="text-[11px] text-[var(--color-text-secondary)]">{t.value}</span>
            <span className={`text-[10px] ${t.up ? "text-[var(--color-accent-green)]" : "text-[var(--color-accent-red)]"}`}>
              {t.change}
            </span>
          </div>
        ))}
      </div>

      {/* Mode indicators + clock */}
      <div className="flex items-center gap-4">
        <div className="hidden sm:flex items-center gap-3">
          <span className="flex items-center gap-[5px]">
            <span className="w-[5px] h-[5px] rounded-full bg-[var(--color-accent-blue)] opacity-80" />
            <span className="text-[8px] text-[var(--color-text-dim)] tracking-[.12em]">RESEARCH MODE</span>
          </span>
          <span className="text-[var(--color-border-default)]">·</span>
          <span className="flex items-center gap-[5px]">
            <span className="w-[5px] h-[5px] rounded-full bg-[var(--color-accent-red)] animate-pulse-amber" />
            <span className="text-[8px] text-[var(--color-text-dim)] tracking-[.12em]">EXECUTION DISABLED</span>
          </span>
        </div>

        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.1em] border-l border-[var(--color-border-default)] pl-4">
          {time}
        </span>
      </div>

    </header>
  );
}
