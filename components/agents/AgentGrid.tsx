import { AgentCard } from "@/components/agents/AgentCard";
import type { Agent } from "@/types/agent";

interface AgentGridProps {
  agents: Agent[];
}

export function AgentGrid({ agents }: AgentGridProps) {
  return (
    <div className="grid grid-cols-3 gap-[10px]">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  );
}
