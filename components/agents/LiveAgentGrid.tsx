"use client";

/**
 * components/agents/LiveAgentGrid.tsx
 *
 * Polls /api/signals and merges live counts into static AGENTS config.
 * Clicking a card expands it in-place (col-span-3) to show a full breakdown.
 * Clicking × or the same card again collapses it.
 *
 * AgentGrid and AgentCard are intentionally left untouched — this component
 * replaces them in the render path when expansion is needed.
 */

import { useEffect, useState } from "react";
import { AGENTS }              from "@/config/agents";
import { SIGNALS_POLL_MS }     from "@/config/polling";
import { StatusDot }           from "@/components/ui/StatusDot";
import type { Agent }          from "@/types/agent";

// ─── API types ─────────────────────────────────────────────────────────────

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

// ─── Merge live counts into static config ──────────────────────────────────

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
      status: hasSignals
        ? hasBuy ? "active" : "scanning"
        : agent.status === "active" ? "scanning" : agent.status,
    };
  });
}

// ─── Per-agent static meta ─────────────────────────────────────────────────

interface AgentMeta {
  tagline:     string;
  description: string;
  indicators:  string[];
  logic:       { label: string; detail: string }[];
  signalTypes: { type: string; color: string; condition: string }[];
  notes?:      string;
}

const AGENT_META: Record<string, AgentMeta> = {
  A1: {
    tagline: "GPT-4o powered momentum classifier",
    description:
      "Reads pre-fetched indicator and volatility data for each symbol, then calls GPT-4o to classify short-term momentum into 1 of 8 market states. The agent never fetches market data itself — all indicator computation happens upstream in the cache layer.",
    indicators: ["RSI (1h)", "MACD histogram (1h)", "EMA20 (1h)", "ATR (1h)", "Volume / Relative Volume"],
    logic: [
      { label: "1. Structure",   detail: "Determines directional bias using price vs EMA20 and EMA20 slope." },
      { label: "2. Momentum",    detail: "Evaluates RSI level and change, MACD histogram sign and direction, and whether volume confirms the move." },
      { label: "3. Implication", detail: "Synthesizes structure and momentum into a final market-state classification and 3-sentence reasoning output. ATR helps normalize how extended price is from EMA20." },
    ],
    signalTypes: [
      { type: "BUY",   color: "text-[var(--color-accent-green)]", condition: "acceleration · trend_continuation · pullback_to_support" },
      { type: "WATCH", color: "text-[var(--color-accent-blue)]",  condition: "extended_but_strong · decelerating · oversold_bounce" },
      { type: "SELL",  color: "text-[var(--color-accent-red)]",   condition: "rollover_risk" },
      { type: "—",     color: "text-[var(--color-text-dim)]",     condition: "neutral" },
    ],
    notes: "Confidence is set by GPT-4o based on indicator alignment: high = strong agreement, medium = mixed evidence, low = weak or incomplete data.",
  },
  A2: {
    tagline: "Bollinger Band breakout detector",
    description:
      "Monitors whether price is breaking above the upper or below the lower Bollinger Band. Breakouts with expanding band width and volume confirmation are flagged as high-conviction moves.",
    indicators: ["Bollinger Bands (20, 2σ)", "Band width", "Volume"],
    logic: [
      { label: "Upper band breach", detail: "Price closes above the upper band with expanding width — bullish breakout signal." },
      { label: "Lower band breach", detail: "Price closes below the lower band — bearish signal, potential continuation down." },
      { label: "Band squeeze",      detail: "Tight bands (low width) indicate consolidation. A breakout from a squeeze carries higher momentum." },
    ],
    signalTypes: [
      { type: "BUY",   color: "text-[var(--color-accent-green)]", condition: "Upper band breakout with volume confirmation" },
      { type: "SELL",  color: "text-[var(--color-accent-red)]",   condition: "Lower band breakdown" },
      { type: "WATCH", color: "text-[var(--color-accent-blue)]",  condition: "Band squeeze forming" },
    ],
    notes: "Currently scanning but not yet connected to live indicator data.",
  },
  A3: {
    tagline: "EMA 50/200 golden & death cross tracker",
    description:
      "Watches the relationship between EMA50 and EMA200 across the stock watchlist. Golden cross signals a long-term bullish shift. Death cross signals the opposite.",
    indicators: ["EMA50 (1d)", "EMA200 (1d)", "Price relative to both EMAs"],
    logic: [
      { label: "Golden cross",  detail: "EMA50 crosses above EMA200 — long-term bullish structure confirmed." },
      { label: "Death cross",   detail: "EMA50 crosses below EMA200 — long-term bearish structure shift." },
      { label: "EMA alignment", detail: "Price > EMA50 > EMA200 = ideal bull alignment. Inverse = bear alignment." },
    ],
    signalTypes: [
      { type: "BUY",  color: "text-[var(--color-accent-green)]", condition: "Golden cross or price above both EMAs" },
      { type: "SELL", color: "text-[var(--color-accent-red)]",   condition: "Death cross or price below both EMAs" },
    ],
    notes: "Stocks only — EMA 50/200 crosses are less meaningful for crypto on shorter timeframes.",
  },
  A4: {
    tagline: "Deep RSI oversold bounce detector",
    description:
      "Looks for extreme RSI readings (sub-30) combined with MACD histogram improvement. Designed to catch capitulation events where selling is exhausted and a short-term bounce is likely.",
    indicators: ["RSI (1h or 4h)", "MACD histogram", "Price distance from EMA20"],
    logic: [
      { label: "Oversold condition", detail: "RSI < 30 — price is deeply oversold relative to recent history." },
      { label: "Histogram turning",  detail: "MACD histogram ticking up from negative — early sign of momentum shift." },
      { label: "Mean distance",      detail: "Price far below EMA20 increases reversion probability — but also bearish risk in strong downtrends." },
    ],
    signalTypes: [
      { type: "WATCH", color: "text-[var(--color-accent-blue)]",  condition: "RSI < 30 + histogram improving" },
      { type: "BUY",   color: "text-[var(--color-accent-green)]", condition: "RSI < 25 + histogram turning positive" },
    ],
    notes: "High false-positive rate in strong downtrends. Use with broader structure confirmation.",
  },
  A5: {
    tagline: "ATR volatility spike detector",
    description:
      "Flags symbols where ATR is spiking relative to its recent baseline. Volatility expansions often precede or accompany major directional moves.",
    indicators: ["ATR (1h)", "ATR% of price", "Candle range relative to ATR"],
    logic: [
      { label: "ATR spike",       detail: "Current ATR significantly above its 20-period average — volatility expanding." },
      { label: "Range expansion", detail: "Candle high–low range exceeds 1.5× ATR — unusual single-bar move." },
      { label: "Direction bias",  detail: "Spike on bullish candle = expansion. Spike on bearish candle = breakdown risk." },
    ],
    signalTypes: [
      { type: "WATCH", color: "text-[var(--color-accent-blue)]",  condition: "ATR spike without directional bias" },
      { type: "BUY",   color: "text-[var(--color-accent-green)]", condition: "ATR spike on bullish candle" },
      { type: "SELL",  color: "text-[var(--color-accent-red)]",   condition: "ATR spike on bearish candle" },
    ],
    notes: "Idle until ATR threshold is crossed. Most useful during earnings or macro events.",
  },
};

// ─── Expanded card ─────────────────────────────────────────────────────────

function ExpandedAgentCard({
  agent,
  onClose,
}: {
  agent:   Agent;
  onClose: () => void;
}) {
  const meta     = AGENT_META[agent.id];
  const isActive = agent.status === "active" || agent.status === "scanning";

  return (
    <div className={`
      col-span-3 rounded-[6px] border px-[18px] py-[14px]
      bg-[var(--color-surface-card)]
      ${isActive ? "border-[rgba(34,211,160,0.25)]" : "border-[var(--color-border-default)]"}
    `}>

      {/* Header */}
      <div className="flex items-start justify-between mb-[10px]">
        <div className="flex items-center gap-[8px]">
          <StatusDot status={agent.status} />
          <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">
            {agent.name}
          </span>
          {meta && (
            <span className="text-[9px] text-[var(--color-text-dim)]">— {meta.tagline}</span>
          )}
        </div>

        <div className="flex items-center gap-[14px]">
          <div className="flex gap-[10px]">
            <span className="text-[9px] text-[var(--color-text-muted)]">
              SIGNALS <span className="text-[10px] text-[#4a8a6a]">{agent.signalCount}</span>
            </span>
            <span className="text-[9px] text-[var(--color-text-muted)]">
              ALERTS <span className="text-[10px] text-[#4a8a6a]">{agent.alertCount}</span>
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-text-dim)] hover:text-[var(--color-text-primary)] text-[16px] leading-none transition-colors"
          >
            ×
          </button>
        </div>
      </div>

      {/* Last action */}
      <div className="text-[8px] text-[var(--color-text-dim)] pb-[12px] mb-[12px] border-b border-[var(--color-border-subtle)]">
        {agent.lastAction}
      </div>

      {meta ? (
        <div className="grid grid-cols-3 gap-[20px]">

          {/* Col 1 — How it works + indicators */}
          <div className="space-y-[12px]">
            <div>
              <p className="text-[8px] font-semibold tracking-widest text-[var(--color-text-dim)] uppercase mb-[5px]">
                How It Works
              </p>
              <p className="text-[10px] text-[var(--color-text-secondary)] leading-[1.6]">
                {meta.description}
              </p>
            </div>
            <div>
              <p className="text-[8px] font-semibold tracking-widest text-[var(--color-text-dim)] uppercase mb-[5px]">
                Indicators
              </p>
              <div className="flex flex-wrap gap-[4px]">
                {meta.indicators.map((ind) => (
                  <span
                    key={ind}
                    className="text-[9px] text-[var(--color-text-secondary)] border border-[var(--color-border-default)] rounded-[3px] px-[6px] py-[2px]"
                  >
                    {ind}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Col 2 — Reasoning steps */}
          <div>
            <p className="text-[8px] font-semibold tracking-widest text-[var(--color-text-dim)] uppercase mb-[5px]">
              Reasoning Steps
            </p>
            <div className="space-y-[8px]">
              {meta.logic.map(({ label, detail }) => (
                <div key={label}>
                  <p className="text-[9px] font-medium text-[var(--color-text-primary)] mb-[2px]">
                    {label}
                  </p>
                  <p className="text-[9px] text-[var(--color-text-secondary)] leading-[1.5]">
                    {detail}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Col 3 — Signal outputs + notes */}
          <div className="space-y-[12px]">
            <div>
              <p className="text-[8px] font-semibold tracking-widest text-[var(--color-text-dim)] uppercase mb-[5px]">
                Signal Outputs
              </p>
              <div className="space-y-[5px]">
                {meta.signalTypes.map(({ type, color, condition }) => (
                  <div key={type} className="flex items-start gap-[8px]">
                    <span className={`text-[9px] font-semibold w-[36px] flex-shrink-0 ${color}`}>
                      {type}
                    </span>
                    <span className="text-[9px] text-[var(--color-text-dim)] leading-[1.4]">
                      {condition}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {meta.notes && (
              <div className="border-t border-[var(--color-border-subtle)] pt-[10px]">
                <p className="text-[9px] text-[var(--color-text-dim)] leading-[1.5] italic">
                  {meta.notes}
                </p>
              </div>
            )}
          </div>

        </div>
      ) : (
        <p className="text-[10px] text-[var(--color-text-dim)]">No details available.</p>
      )}
    </div>
  );
}

// ─── Collapsed card — mirrors AgentCard exactly ────────────────────────────

function CollapsedAgentCard({
  agent,
  onClick,
}: {
  agent:   Agent;
  onClick: () => void;
}) {
  const isActive = agent.status === "active" || agent.status === "scanning";

  return (
    <div
      onClick={onClick}
      className={`
        bg-[var(--color-surface-card)] border rounded-[6px] px-[14px] py-[12px]
        transition-colors duration-150 cursor-pointer group
        hover:border-[var(--color-text-muted)]
        ${isActive ? "border-[rgba(34,211,160,0.25)]" : "border-[var(--color-border-default)]"}
      `}
    >
      <div className="flex justify-between items-start mb-2">
        <span className={`text-[11px] font-semibold ${isActive ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}`}>
          {agent.name}
        </span>
        <div className="flex items-center gap-[6px]">
          <span className="text-[8px] text-[var(--color-text-dim)] opacity-0 group-hover:opacity-40 transition-opacity">
            details →
          </span>
          <StatusDot status={agent.status} />
        </div>
      </div>

      <div className="text-[9px] text-[var(--color-text-dim)] mb-2">{agent.focus}</div>

      <div className="flex gap-3">
        <div className="text-[9px] text-[var(--color-text-muted)]">
          SIGNALS <span className="text-[10px] text-[#4a8a6a]">{agent.signalCount}</span>
        </div>
        <div className="text-[9px] text-[var(--color-text-muted)]">
          ALERTS <span className="text-[10px] text-[#4a8a6a]">{agent.alertCount}</span>
        </div>
      </div>

      <div className="mt-[6px] pt-[6px] border-t border-[var(--color-border-subtle)] text-[8px] text-[var(--color-text-dim)]">
        {agent.lastAction}
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export function LiveAgentGrid() {
  const [agents, setAgents]         = useState<Agent[]>(AGENTS);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  const expandedAgent   = agents.find((a) => a.id === expandedId) ?? null;
  const collapsedAgents = agents.filter((a) => a.id !== expandedId);

  return (
    <div className="grid grid-cols-3 gap-[10px]">
      {/* Expanded card spans full row, rendered at top */}
      {expandedAgent && (
        <ExpandedAgentCard
          agent={expandedAgent}
          onClose={() => setExpandedId(null)}
        />
      )}

      {/* Remaining 4 cards fill the next row normally */}
      {collapsedAgents.map((agent) => (
        <CollapsedAgentCard
          key={agent.id}
          agent={agent}
          onClick={() => setExpandedId((prev) => (prev === agent.id ? null : agent.id))}
        />
      ))}
    </div>
  );
}
