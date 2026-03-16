"use client";

/**
 * components/dashboard/ActivityLog.tsx
 * Polls /api/signals every 30s for live activity entries.
 */

import { useEffect, useState, useCallback } from "react";
import type { ActivityEntry } from "@/types/agent";

const iconMap = {
  signal: { cls: "bg-[var(--color-surface-hover)] text-[var(--color-accent-green)]",  char: "▲" },
  scan:   { cls: "bg-[var(--color-surface-hover)] text-[var(--color-accent-blue)]",   char: "◎" },
  alert:  { cls: "bg-[var(--color-surface-hover)] text-[var(--color-accent-amber)]",  char: "!" },
  error:  { cls: "bg-[var(--color-surface-hover)] text-[var(--color-accent-red)]",    char: "✕" },
};

export function ActivityLog() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

  const fetchActivity = useCallback(async () => {
    try {
      const res  = await fetch("/api/signals");
      const data = await res.json();
      if (data.activity && Array.isArray(data.activity) && data.activity.length > 0) {
        setEntries(data.activity);
      }
    } catch {
      // Keep showing whatever is currently in state on error
    }
  }, []);

  useEffect(() => {
    fetchActivity();
    const id = setInterval(fetchActivity, 30_000);
    return () => clearInterval(id);
  }, [fetchActivity]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden px-[18px] pb-[14px]">
      <div className="flex justify-between items-center py-3 shrink-0">
        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.14em]">AGENT ACTIVITY</span>
        <div className="flex items-center gap-[5px]">
          <span className="inline-block w-[5px] h-[5px] rounded-full bg-[var(--color-accent-green)] animate-pulse-dot" />
          <span className="text-[9px] text-[var(--color-text-muted)] tracking-[.08em]">Live</span>
        </div>
      </div>

      <div className="overflow-y-auto flex-1">
        {entries.length === 0 ? (
          <p className="text-[9px] text-[var(--color-text-dim)] opacity-40 pt-[8px]">
            Waiting for first scan…
          </p>
        ) : (
          entries.map((entry, i) => {
            const icon = iconMap[entry.type] ?? iconMap.scan;
            return (
              <div
                key={i}
                className="flex gap-[10px] py-[7px] border-b border-[var(--color-border-subtle)] items-start"
              >
                <span className="text-[9px] text-[var(--color-text-dim)] whitespace-nowrap pt-[1px] min-w-[44px]">
                  {entry.time}
                </span>
                <div
                  className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] shrink-0 mt-[1px] ${icon.cls}`}
                >
                  {icon.char}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[9px] text-[var(--color-text-dim)] mb-[1px]">{entry.agent}</div>
                  <div
                    className="text-[11px] text-[var(--color-text-secondary)] leading-[1.5]"
                    dangerouslySetInnerHTML={{ __html: entry.message }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
