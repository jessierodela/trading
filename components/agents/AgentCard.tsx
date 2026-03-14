import { StatusDot } from "@/components/ui/StatusDot";
import type { Agent } from "@/types/agent";

interface AgentCardProps {
  agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
  const isActive = agent.status === "active" || agent.status === "scanning";

  return (
    <div className={`
      bg-[var(--color-surface-card)] border rounded-[6px] px-[14px] py-[12px]
      transition-colors duration-150 cursor-pointer
      hover:border-[var(--color-text-muted)]
      ${isActive
        ? "border-[rgba(34,211,160,0.25)]"
        : "border-[var(--color-border-default)]"
      }
    `}>
      <div className="flex justify-between items-start mb-2">
        <span className={`text-[11px] font-semibold ${isActive ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}`}>
          {agent.name}
        </span>
        <StatusDot status={agent.status} />
      </div>

      <div className="text-[9px] text-[var(--color-text-dim)] mb-2">{agent.focus}</div>

      <div className="flex gap-3">
        <div className="text-[9px] text-[var(--color-text-muted)]">
          SIGNALS{" "}
          <span className="text-[10px] text-[#4a8a6a]">{agent.signalCount}</span>
        </div>
        <div className="text-[9px] text-[var(--color-text-muted)]">
          ALERTS{" "}
          <span className="text-[10px] text-[#4a8a6a]">{agent.alertCount}</span>
        </div>
      </div>

      <div className="mt-[6px] pt-[6px] border-t border-[var(--color-border-subtle)] text-[8px] text-[var(--color-text-dim)]">
        {agent.lastAction}
      </div>
    </div>
  );
}
