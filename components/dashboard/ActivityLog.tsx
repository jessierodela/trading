import type { ActivityEntry } from "@/types/agent";

interface ActivityLogProps {
  entries: ActivityEntry[];
}

const iconMap = {
  signal: { cls: "bg-[#0a2a1a] text-[var(--color-accent-green)]",  char: "▲" },
  scan:   { cls: "bg-[#0a1a2a] text-[var(--color-accent-blue)]",   char: "◎" },
  alert:  { cls: "bg-[#2a1a0a] text-[var(--color-accent-amber)]",  char: "!" },
  error:  { cls: "bg-[#2a0a0a] text-[var(--color-accent-red)]",    char: "✕" },
};

export function ActivityLog({ entries }: ActivityLogProps) {
  return (
    <div className="flex flex-col flex-1 overflow-hidden px-[18px] pb-[14px]">
      <div className="flex justify-between items-center py-3 shrink-0">
        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.16em]">AGENT ACTIVITY LOG</span>
        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.1em]">LIVE</span>
      </div>

      <div className="overflow-y-auto flex-1">
        {entries.map((entry, i) => {
          const icon = iconMap[entry.type] ?? iconMap.scan;
          return (
            <div key={i} className="flex gap-[10px] py-[7px] border-b border-[var(--color-border-subtle)] items-start">
              <span className="text-[9px] text-[var(--color-text-dim)] whitespace-nowrap pt-[1px] min-w-[44px]">
                {entry.time}
              </span>
              <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] shrink-0 mt-[1px] ${icon.cls}`}>
                {icon.char}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[9px] text-[var(--color-text-muted)] mb-[1px]">{entry.agent}</div>
                <div
                  className="text-[11px] text-[var(--color-text-secondary)] leading-[1.4]"
                  dangerouslySetInnerHTML={{ __html: entry.message }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
