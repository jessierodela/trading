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
  const [time, setTime] = useState("");
  const [tickers, setTickers] = useState<TickerState[]>(EMPTY);

  // Clock — Central Time
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

  // Market data — hits /api/quotes (server-side, safe to use yahoo-finance2)
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
            return { label: a.label, ...q };
          })
        );
      } catch {
        // leave previous values intact on error
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
          TRADING
        </span>
        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.15em] border-l border-[var(--color-border-default)] pl-3">
          AGENT DASHBOARD
        </span>
      </div>

      {/* Market tickers */}
      <div className="flex gap-6 items-center">
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

      {/* Clock */}
      <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.1em]">
        {time}
      </span>
    </header>
  );
}