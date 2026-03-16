"use client";

/**
 * components/layout/SignalsPanel.tsx
 * Right-hand panel rendering live agent alerts passed from the server.
 */

import type { Alert } from "@/types/agent";

interface SignalsPanelProps {
  alerts: Alert[];
}

const typeStyles: Record<Alert["type"], { label: string; color: string }> = {
  buy:   { label: "BUY",   color: "text-[var(--color-accent-green)]"  },
  watch: { label: "WATCH", color: "text-[var(--color-accent-blue)]"   },
  warn:  { label: "WARN",  color: "text-[var(--color-accent-orange)]" },
};

export function SignalsPanel({ alerts }: SignalsPanelProps) {
  return (
    <aside className="w-[200px] shrink-0 border-l border-[var(--color-border-default)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-[14px] py-[10px] border-b border-[var(--color-border-default)] shrink-0 flex items-center gap-[6px]">
        <span className="w-[5px] h-[5px] rounded-full bg-[var(--color-accent-green)] opacity-80" />
        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.14em]">SIGNALS</span>
      </div>

      {/* Alert list */}
      <div className="overflow-y-auto flex-1">
        {alerts.map((alert, i) => {
          const style = typeStyles[alert.type] ?? typeStyles.watch;
          return (
            <div
              key={i}
              className="px-[14px] py-[10px] border-b border-[var(--color-border-default)] last:border-b-0"
            >
              {/* Symbol + type badge */}
              <div className="flex items-center justify-between mb-[4px]">
                <span className="text-[12px] font-medium text-[var(--color-text-primary)]">
                  {alert.symbol}
                </span>
                <span className={`text-[9px] font-semibold tracking-wide ${style.color}`}>
                  {style.label}
                </span>
              </div>

              {/* Message */}
              <p className="text-[10px] text-[var(--color-text-secondary)] leading-[1.4] mb-[5px]">
                {alert.message}
              </p>

              {/* Agent + confidence */}
              <div className="flex items-center justify-between mb-[2px]">
                <span className="text-[9px] text-[var(--color-text-dim)]">{alert.agent}</span>
                <span className="text-[9px] text-[var(--color-text-dim)]">{alert.confidence}%</span>
              </div>

              {/* Confidence bar */}
              <div className="h-[2px] w-full bg-[var(--color-border-default)] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--color-accent-green)] opacity-60"
                  style={{ width: `${alert.confidence}%` }}
                />
              </div>

              {/* Timestamp */}
              <div className="mt-[4px]">
                <span className="text-[9px] text-[var(--color-text-dim)] opacity-50">{alert.time}</span>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}