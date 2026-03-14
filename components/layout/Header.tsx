"use client";

import { useEffect, useState } from "react";
import { Pulse } from "@/components/ui/Pulse";

const MARKET_TICKERS = [
  { label: "S&P 500", value: "5,234.18", change: "+0.61%", up: true },
  { label: "NASDAQ",  value: "18,441.55", change: "+0.84%", up: true },
  { label: "BTC",     value: "67,420",    change: "+2.33%", up: true },
  { label: "VIX",     value: "13.88",     change: "-1.20%", up: false },
];

export function Header() {
  const [time, setTime] = useState("");

  useEffect(() => {
    const tick = () => {
      const t = new Date().toLocaleTimeString("en-US", {
        hour12: false,
        timeZone: "America/New_York",
      });
      setTime(t + " EST");
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
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
        {MARKET_TICKERS.map((t) => (
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
