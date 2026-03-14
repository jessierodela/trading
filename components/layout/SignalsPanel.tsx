import { AlertCard } from "@/components/alerts/AlertCard";
import type { Alert } from "@/types/agent";

interface SignalsPanelProps {
  alerts: Alert[];
}

export function SignalsPanel({ alerts }: SignalsPanelProps) {
  return (
    <aside className="w-[280px] border-l border-[var(--color-border-default)] flex flex-col overflow-hidden bg-[var(--color-surface-panel)] shrink-0">

      <div className="flex items-center justify-between px-[14px] py-[10px] border-b border-[var(--color-border-default)]">
        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.14em]">ALERTS</span>
        <div className="flex items-center gap-[5px]">
          <span className="inline-block w-[5px] h-[5px] rounded-full bg-[var(--color-accent-green)] animate-pulse-dot" />
          <span className="text-[9px] text-[var(--color-text-muted)] tracking-[.08em]">Live</span>
        </div>
      </div>

      <div className="overflow-y-auto flex-1">
        {alerts.map((alert, i) => (
          <AlertCard key={i} alert={alert} />
        ))}
      </div>
    </aside>
  );
}
