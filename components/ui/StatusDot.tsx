import type { AgentStatus } from "@/types/agent";

const statusConfig: Record<AgentStatus, { color: string; animated: boolean }> = {
  active:   { color: "bg-[var(--color-accent-green)]", animated: true },
  scanning: { color: "bg-[var(--color-accent-amber)]", animated: true },
  idle:     { color: "bg-[var(--color-text-dim)]",     animated: false },
  error:    { color: "bg-[var(--color-accent-red)]",   animated: false },
};

interface StatusDotProps {
  status: AgentStatus;
}

export function StatusDot({ status }: StatusDotProps) {
  const { color, animated } = statusConfig[status];
  return (
    <span className={`
      inline-block w-[6px] h-[6px] rounded-full shrink-0 mt-[2px]
      ${color}
      ${animated && status === "active"   ? "animate-pulse-dot"   : ""}
      ${animated && status === "scanning" ? "animate-pulse-amber" : ""}
    `} />
  );
}
