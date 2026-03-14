import { AlertCard } from "@/components/alerts/AlertCard";
import type { Alert } from "@/types/agent";

interface SignalsPanelProps {
  alerts: Alert[];
}

export function SignalsPanel({ alerts }: SignalsPanelProps) {
  return (
    <aside className="w-[280px] border-l border-[var(--color-border-default)] flex flex-col overflow-hidden bg-[var(--color-surface-panel)] shrink-0">

      <div className="flex items-center justify-between px-[14px] py-[10px] border-b border-[var(--color-border-default)]">
        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.16em]">ALERTS</span>
        <span className="text-[8px] px-[7px] py-[2px] rounded-sm tracking-[.06em] bg-[#0a2a1a] border border-[rgba(34,211,160,0.25)] text-[var(--color-accent-green)]">
          LIVE
        </span>
      </div>

      <div className="overflow-y-auto flex-1">
        {alerts.map((alert, i) => (
          <AlertCard key={i} alert={alert} />
        ))}
      </div>
    </aside>
  );
}
