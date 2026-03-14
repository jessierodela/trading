import type { Alert } from "@/types/agent";

interface AlertCardProps {
  alert: Alert;
}

const typeStyles = {
  buy:   "bg-[#0a2a1a] text-[var(--color-accent-green)] border border-[rgba(34,211,160,0.2)]",
  watch: "bg-[#0a1a2a] text-[var(--color-accent-blue)]  border border-[rgba(74,138,204,0.2)]",
  warn:  "bg-[#2a1a0a] text-[var(--color-accent-amber)] border border-[rgba(245,166,35,0.2)]",
};

export function AlertCard({ alert }: AlertCardProps) {
  return (
    <div className="px-[14px] py-[10px] border-b border-[var(--color-border-subtle)] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors">

      <div className="flex justify-between items-center mb-[4px]">
        <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{alert.symbol}</span>
        <span className="text-[9px] text-[var(--color-text-dim)]">{alert.time}</span>
      </div>

      <div className="mb-[5px]">
        <span className={`text-[9px] px-[6px] py-[1px] rounded-sm tracking-[.06em] ${typeStyles[alert.type]}`}>
          {alert.type.toUpperCase()}
        </span>
      </div>

      <p className="text-[10px] text-[var(--color-text-muted)] leading-[1.5] mb-[4px]">
        {alert.message}
      </p>

      <p className="text-[8px] text-[var(--color-text-dim)] mb-[6px]">{alert.agent}</p>

      {/* Confidence bar */}
      <div className="flex items-center gap-[6px]">
        <span className="text-[8px] text-[var(--color-text-dim)]">CONFIDENCE</span>
        <div className="flex-1 h-[2px] bg-[var(--color-border-default)] rounded-full">
          <div
            className="h-full rounded-full bg-[var(--color-accent-green)]"
            style={{ width: `${alert.confidence}%` }}
          />
        </div>
        <span className="text-[9px] text-[var(--color-accent-green)]">{alert.confidence}%</span>
      </div>
    </div>
  );
}
