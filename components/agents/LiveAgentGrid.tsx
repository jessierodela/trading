"use client";

/**
 * components/agents/LiveAgentGrid.tsx
 *
 * Client wrapper around AgentGrid.
 * Polls /api/signals and merges live signalCount, alertCount, lastAction,
 * and status into the static AGENTS config so cards show real counts.
 *
 * Replace <AgentGrid agents={AGENTS} /> in page.tsx with <LiveAgentGrid />.
 */

import { useEffect, useState }  from "react";
import { AgentGrid }            from "@/components/agents/AgentGrid";
import { AGENTS }               from "@/config/agents";
import { SIGNALS_POLL_MS }      from "@/config/polling";
import type { Agent }           from "@/types/agent";

interface AgentResult {
  id:          string;
  name:        string;
  signalCount: number;
  alertCount:  number;
  lastAction:  string;
  signals:     { type: string }[];
}

interface SignalsResponse {
  agentResults: AgentResult[];
}

function mergeAgents(base: Agent[], results: AgentResult[]): Agent[] {
  const resultMap = new Map(results.map((r) => [r.id, r]));

  return base.map((agent) => {
    const live = resultMap.get(agent.id);
    if (!live) return agent;

    const hasSignals = live.signalCount > 0;
    const hasBuy     = live.signals?.some((s) => s.type === "buy");

    return {
      ...agent,
      signalCount: live.signalCount,
      alertCount:  live.alertCount,
      lastAction:  live.lastAction ?? agent.lastAction,
      status:      hasSignals
        ? hasBuy ? "active" : "scanning"
        : agent.status === "active" ? "scanning" : agent.status,
    };
  });
}

export function LiveAgentGrid() {
  const [agents, setAgents] = useState<Agent[]>(AGENTS);

  async function fetchAndMerge() {
    try {
      const res  = await fetch("/api/signals");
      const data = (await res.json()) as SignalsResponse;
      if (data.agentResults?.length) {
        setAgents(mergeAgents(AGENTS, data.agentResults));
      }
    } catch (err) {
      console.error("[LiveAgentGrid] fetch error", err);
    }
  }

  useEffect(() => {
    fetchAndMerge();
    const id = setInterval(fetchAndMerge, SIGNALS_POLL_MS);
    return () => clearInterval(id);
  }, []);

  return <AgentGrid agents={agents} />;
}