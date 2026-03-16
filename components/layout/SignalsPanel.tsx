"use client";

/**
 * components/layout/SignalsPanel.tsx
 * Right-hand panel showing live signal feed.
 */

import { useState } from "react";

interface Signal {
  id: string;
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  indicator: string;
  timeframe: string;
  timestamp: string;
}

const MOCK_SIGNALS: Signal[] = [
  { id: "1", symbol: "BTC",  action: "BUY",  indicator: "RSI",     timeframe: "4H",  timestamp: "2m ago" },
  { id: "2", symbol: "NVDA", action: "SELL", indicator: "MACD",    timeframe: "1D",  timestamp: "5m ago" },
  { id: "3", symbol: "SOL",  action: "HOLD", indicator: "VWAP",    timeframe: "1H",  timestamp: "9m ago" },
  { id: "4", symbol: "AAPL", action: "BUY",  indicator: "EMA 20",  timeframe: "1D",  timestamp: "14m ago" },
  { id: "5", symbol: "ETH",  action: "BUY",  indicator: "Stoch",   timeframe: "4H",  timestamp: "21m ago" },
  { id: "6", symbol: "TSLA", action: "SELL", indicator: "BB",      timeframe: "1D",  timestamp: "30m ago" },
  { id: "7", symbol: "SPY",  action: "HOLD", indicator: "MACD",    timeframe: "1W",  timestamp: "45m ago" },
];

const actionStyles: Record<Signal["action"], string> = {
  BUY:  "text-[var(--color-accent-green)]",
  SELL: "text-[var(--color-accent-red)]",
  HOLD: "text-[var(--color-text-dim)]",
};

export function SignalsPanel() {
  const [signals] = useState<Signal[]>(MOCK_SIGNALS);

  return (
    <aside className="w-[160px] shrink-0 border-l border-[var(--color-border-default)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-[14px] py-[10px] border-b border-[var(--color-border-default)] shrink-0 flex items-center gap-[6px]">
        <span className="w-[5px] h-[5px] rounded-full bg-[var(--color-accent-green)] opacity-80" />
        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.14em]">SIGNALS</span>
      </div>

      {/* Signal list */}
      <div className="overflow-y-auto flex-1">
        {signals.map((s) => (
          <div
            key={s.id}
            className="px-[14px] py-[10px] border-b border-[var(--color-border-default)] last:border-b-0"
          >
            {/* Symbol + action */}
            <div className="flex items-center justify-between mb-[3px]">
              <span className="text-[12px] font-medium text-[var(--color-text-primary)]">
                {s.symbol}
              </span>
              <span className={`text-[10px] font-semibold tracking-wide ${actionStyles[s.action]}`}>
                {s.action}
              </span>
            </div>

            {/* Indicator + timeframe */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[var(--color-text-dim)]">{s.indicator}</span>
              <span className="text-[10px] text-[var(--color-text-dim)]">{s.timeframe}</span>
            </div>

            {/* Timestamp */}
            <div className="mt-[2px]">
              <span className="text-[9px] text-[var(--color-text-dim)] opacity-60">{s.timestamp}</span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
