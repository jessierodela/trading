// components/dashboard/SystemEventLog.tsx
// Operations-style log — makes the platform feel alive without implying live trading.

import { SYSTEM_EVENTS } from "@/lib/dashboard/dashboardArchitecture";

const severityIcon: Record<string, string> = {
  success: "▲",
  info:    "◎",
  warning: "!",
  error:   "✕",
};

const severityColor: Record<string, string> = {
  success: "text-[var(--color-accent-green)]",
  info:    "text-[var(--color-accent-blue)]",
  warning: "text-[var(--color-accent-amber)]",
  error:   "text-[var(--color-accent-red)]",
};

export function SystemEventLog() {
  return (
    <section className="px-6 py-6">
      <div className="flex items-center justify-between mb-4">
        <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.18em] uppercase">
          System Event Log
        </p>
        <div className="flex items-center gap-[5px]">
          <span className="inline-block w-[5px] h-[5px] rounded-full bg-[var(--color-text-dim)]" />
          <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.08em]">
            Static — replace with live feed when pipeline is wired
          </span>
        </div>
      </div>

      <div className="space-y-0">
        {SYSTEM_EVENTS.map((event, i) => (
          <div
            key={i}
            className="flex gap-3 py-[9px] border-b border-[var(--color-border-subtle)] items-start"
          >
            {/* Icon */}
            <div
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] bg-[var(--color-surface-hover)] shrink-0 mt-[1px] ${severityColor[event.severity]}`}
            >
              {severityIcon[event.severity]}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-3 mb-[2px]">
                <span className={`text-[9px] font-medium tracking-[.04em] ${severityColor[event.severity]}`}>
                  {event.label}
                </span>
                <span className="text-[8px] text-[var(--color-text-dim)]">{event.timestamp}</span>
              </div>
              <p className="text-[10px] text-[var(--color-text-muted)] leading-[1.5]">
                {event.description}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
