"use client";

/**
 * components/agents/LiveAgentGrid.tsx
 *
 * Polls /api/signals and merges live counts into static AGENTS config.
 * Clicking a card expands it in-place (col-span-3) to show a full breakdown.
 * Clicking × or the same card again collapses it.
 *
 * The Confluence Engine (id "AC") is a sixth card that participates in the
 * same expand/collapse pattern. Its expanded view shows scoring logic and
 * verdict types. Live verdicts are surfaced in the Signals panel detail view.
 *
 * CHANGE LOG:
 *  - Removed "Current Verdicts" from AC expanded card — verdicts live in the
 *    Signals panel detail view (SignalDetailPanel).
 *  - AC AGENT_META updated: inputs and logic use agent names, not IDs.
 *  - Inline comments cleaned of A1–A5 / A1 + A3 style ID references.
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

interface ConfluenceResult {
  symbol:        string;
  verdict:       string;
  weightedScore: number;
  narrative:     string;
  tags:          string[];
  agentVotes:    { agent: string; signal: string; confidence: string; score: number }[];
  gateMet:       boolean;
  hasHardConflict: boolean;
}

interface SignalsResponse {
  agentResults: AgentResult[];
  confluence?:  ConfluenceResult[];
}

// ─── Verdict display helpers ────────────────────────────────────────────────

const VERDICT_STYLE: Record<string, { label: string; color: string }> = {
  aligned_bullish:      { label: "Aligned Bullish",    color: "text-[var(--color-accent-green)]"  },
  bullish_but_extended: { label: "Bullish / Extended", color: "text-[var(--color-accent-blue)]"   },
  mixed_structure:      { label: "Mixed Structure",    color: "text-[var(--color-accent-orange)]" },
  bearish_structure:    { label: "Bearish Structure",  color: "text-[var(--color-accent-red)]"    },
  countertrend_only:    { label: "Countertrend Only",  color: "text-[var(--color-accent-orange)]" },
  no_trade:             { label: "No Trade",           color: "text-[var(--color-text-dim)]"      },
};

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
    tagline: "Momentum classifier with structure-first reasoning",
    description:
      "Reads pre-fetched indicator and volatility data for each symbol, then calls GPT-4o to classify short-term momentum into 1 of 8 market states. The agent never fetches data itself — all indicator computation happens upstream in the cache layer.",
    indicators: [
      "RSI (1h)",
      "MACD histogram (1h)",
      "EMA20 (1h)",
      "Relative volume",
      "ATR (1h)",
      "Distance from EMA20 (ATR)",
      "Candle range (ATR)",
    ],
    logic: [
      { label: "Structure",   detail: "Determines directional bias using price vs EMA20 and EMA20 slope." },
      { label: "Momentum",    detail: "Evaluates RSI level and change, MACD histogram sign and direction, and whether volume confirms momentum." },
      { label: "Implication", detail: "Synthesizes structure and momentum into a final market-state classification and 3-sentence reasoning output. ATR helps normalize how extended price is from EMA20." },
    ],
    signalTypes: [
      { type: "BUY",   color: "text-[var(--color-accent-green)]", condition: "acceleration · trend_continuation · pullback_to_support" },
      { type: "WATCH", color: "text-[var(--color-accent-blue)]",  condition: "extended_but_strong · decelerating · oversold_bounce" },
      { type: "SELL",  color: "text-[var(--color-accent-red)]",   condition: "rollover_risk" },
      { type: "—",     color: "text-[var(--color-text-dim)]",     condition: "neutral" },
    ],
    notes: "Confidence reflects the quality of alignment across structure, momentum, and implication: high = broad confirmation, medium = mixed but usable evidence, low = weak, conflicting, or incomplete data.",
  },
  A2: {
    tagline: "Bollinger Band breakout setup interpreter",
    description:
      "Monitors Bollinger Band structure, band-width compression/expansion, and relative volume to identify breakout, breakdown, or squeeze-watch conditions. Signals are classified as BUY, SELL, or WATCH based on band breach quality, volatility expansion, and confirmation strength.",
    indicators: [
      "Bollinger Bands (20, 2σ)",
      "Band width",
      "Band width direction",
      "Price vs bands",
      "Close quality",
      "Relative volume",
      "Range context",
      "Extension risk",
    ],
    logic: [
      { label: "Structure",           detail: "Price location relative to the Bollinger Bands, volatility state, and whether compression or expansion is present." },
      { label: "Breakout Conditions", detail: "Confirms upper-band or lower-band breach using close quality, band-width expansion, volume confirmation, and extension risk." },
      { label: "Implication",         detail: "Classifies the setup as BUY, SELL, or WATCH based on breakout quality and conviction." },
    ],
    signalTypes: [
      { type: "BUY",   color: "text-[var(--color-accent-green)]", condition: "Bullish breakout confirmed above the upper band with supportive expansion and volume" },
      { type: "SELL",  color: "text-[var(--color-accent-red)]",   condition: "Bearish breakdown confirmed below the lower band with supportive expansion and volume" },
      { type: "WATCH", color: "text-[var(--color-accent-blue)]",  condition: "Squeeze forming, weak confirmation, or setup not yet resolved" },
    ],
    notes: "Connected to live indicator data and evaluating breakout conditions in real time.",
  },
  A3: {
    tagline: "EMA 50/200 market structure & directional bias engine",
    description:
      "Maps broader trend structure using EMA50, EMA200, and price location relative to both. Classifies the market as bullish, bearish, mixed, or transitional and supplies directional context to the rest of the agent stack.",
    indicators: [
      "EMA50 (1D)",
      "EMA200 (1D)",
      "Price vs EMA50",
      "Price vs EMA200",
      "EMA spread",
      "EMA50 slope",
      "EMA200 slope",
      "Cross state",
    ],
    logic: [
      { label: "Structure",        detail: "Checks whether price is above both EMAs, below both, between them, or pressing into one." },
      { label: "EMA alignment",    detail: "Measures whether EMA50 is above EMA200, below EMA200, or actively crossing." },
      { label: "Trend conditions", detail: "Assesses trend strength, slope confirmation, spread quality, and whether structure is clean or transitional." },
      { label: "Implication",      detail: "Outputs bullish, bearish, or watch bias based on alignment quality rather than excitement." },
    ],
    signalTypes: [
      { type: "BUY",   color: "text-[var(--color-accent-green)]", condition: "Bullish structure supports long exposure" },
      { type: "SELL",  color: "text-[var(--color-accent-red)]",   condition: "Bearish structure supports short exposure" },
      { type: "WATCH", color: "text-[var(--color-accent-blue)]",  condition: "Mixed, transitional, or low-conviction structure" },
    ],
    notes: "Context layer only — not a trigger agent",
  },
  A4: {
    tagline: "ATR expansion and move-quality risk interpreter",
    description:
      "Evaluates whether current volatility is healthy and tradeable, or unstable, late, and dangerous to chase. It compares ATR to its recent baseline, measures candle expansion versus ATR, and judges whether the move is directional, non-directional, or exhaustive. This agent frames execution quality, not trend direction.",
    indicators: [
      "ATR (1h)",
      "ATR baseline (20)",
      "ATR% of price",
      "Candle range vs ATR",
      "Bar direction",
      "Body % of range",
      "Close position in bar",
      "Relative volume",
    ],
    logic: [
      { label: "Structure",             detail: "Classifies the volatility regime as compressed, normal, expanding, or extreme." },
      { label: "Volatility conditions", detail: "Measures whether ATR is below, near, above, or far above baseline, and whether the current candle is normal, elevated, or outsized relative to ATR." },
      { label: "Directional quality",   detail: "Checks whether expansion is supportive bullish, supportive bearish, non-directional, or exhaustive." },
      { label: "Implication",           detail: "Decides whether volatility is still tradeable or whether chase and reversal risk are too high." },
    ],
    signalTypes: [
      { type: "WATCH", color: "text-[var(--color-accent-blue)]",  condition: "Volatility is unclear, chaotic, non-directional, or too extended to chase" },
      { type: "BUY",   color: "text-[var(--color-accent-green)]", condition: "Bullish volatility expansion is present and still tradeable" },
      { type: "SELL",  color: "text-[var(--color-accent-red)]",   condition: "Bearish volatility expansion is present and still tradeable" },
    ],
    notes: "Execution-risk layer only — not a trigger agent.",
  },
  A5: {
    tagline: "Oversold bounce detector",
    description:
      "Looks for short-term downside exhaustion using RSI oversold conditions, improving MACD histogram, and price stretched below EMA20. Designed to catch reflex bounce setups after aggressive selling — not long-term trend reversals.",
    indicators: ["RSI (1h)", "MACD histogram (1h)", "Price distance from EMA20"],
    logic: [
      { label: "Oversold condition", detail: "Checks whether RSI is meaningfully oversold. Below 30 is notable; below 25 is deep oversold and stronger for bounce setups." },
      { label: "Histogram turning",  detail: "Evaluates whether the MACD histogram is becoming less negative or turning positive, signaling downside momentum may be fading." },
      { label: "Mean distance",      detail: "Measures how far price is stretched below EMA20. Greater downside extension increases bounce potential, but also raises risk in strong downtrends." },
    ],
    signalTypes: [
      { type: "WATCH", color: "text-[var(--color-accent-blue)]",  condition: "RSI oversold + downside momentum stabilizing + price below EMA20" },
      { type: "BUY",   color: "text-[var(--color-accent-green)]", condition: "Deeply oversold RSI + histogram improving/turning + meaningful stretch below EMA20" },
    ],
    notes: "Countertrend by design. Best used for tactical bounce setups, not trend reversal calls.",
  },
  AC: {
    tagline: "Multi-agent verdict synthesis layer",
    description:
      "Reads the Signal[] outputs from all five agents after each refresh cycle and computes a single weighted directional verdict per symbol. It never fetches indicators — it only reasons over structured agent outputs. A deterministic scorer runs first, then GPT-4o writes a concise narrative explaining what the combined read means.",
    indicators: [
      "Momentum Scout signal + confidence",
      "Breakout Watcher signal + confidence",
      "Trend Follower signal + confidence",
      "Volatility Arbiter signal + confidence",
      "Mean Reversion modifier (when present)",
    ],
    logic: [
      { label: "Gate check",        detail: "Momentum Scout and Trend Follower must both have signals for a symbol. If either is absent, the verdict is no_trade." },
      { label: "Weighted scoring",  detail: "Momentum Scout and Trend Follower carry weight 3 each (structural importance). Breakout Watcher and Volatility Arbiter carry weight 2 each (trigger and execution quality). Confidence multipliers: high = 1.0, medium = 0.7, low = 0.4. Buy = +1, sell = −1, watch = 0." },
      { label: "Veto condition",    detail: "If Volatility Arbiter signals WATCH with extreme or high_risk tags, it flags an active veto — this prevents an aligned_bullish verdict even when the score is high enough." },
      { label: "Mean Reversion modifier", detail: "Mean Reversion is not scored. If it fires a BUY into a mixed_structure verdict, the verdict downgrades to countertrend_only. If it fires into aligned_bullish, a mean_reversion_confluence tag is added." },
      { label: "GPT narrative",     detail: "After the deterministic verdict is set, GPT-4o writes a 3–5 sentence paragraph explaining the confluence read, which agents agree, which conflict, and what would need to change for a cleaner setup." },
    ],
    signalTypes: [
      { type: "Aligned Bullish",    color: "text-[var(--color-accent-green)]",  condition: "Weighted score ≥ +3.0, no veto, Momentum Scout + Trend Follower gate met" },
      { type: "Bullish / Extended", color: "text-[var(--color-accent-blue)]",   condition: "Score ≥ +1.5 — bullish lean with chase or extension risk present" },
      { type: "Mixed Structure",    color: "text-[var(--color-accent-orange)]", condition: "Score between −1.5 and +1.5 — agents disagree, no clear edge" },
      { type: "Bearish Structure",  color: "text-[var(--color-accent-red)]",    condition: "Weighted score ≤ −3.0" },
      { type: "Countertrend Only",  color: "text-[var(--color-accent-orange)]", condition: "Mean Reversion bounce firing into mixed structure — no trend support behind it" },
      { type: "No Trade",           color: "text-[var(--color-text-dim)]",      condition: "Gate not met, hard Momentum Scout / Trend Follower conflict, or insufficient data" },
    ],
    notes: "Score range: −8 (all agents sell at high confidence) to +8 (all agents buy at high confidence). The ±3.0 threshold requires meaningful agreement — a single high-confidence buy is not enough.",
  },
};

// ─── Expanded card ─────────────────────────────────────────────────────────

function ExpandedAgentCard({
  agent,
  confluence,
  onClose,
}: {
  agent:      Agent;
  confluence: ConfluenceResult[];
  onClose:    () => void;
}) {
  const meta     = AGENT_META[agent.id];
  const isAC     = agent.id === "AC";
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
          {!isAC && (
            <div className="flex gap-[10px]">
              <span className="text-[9px] text-[var(--color-text-muted)]">
                SIGNALS <span className="text-[10px] text-[#4a8a6a]">{agent.signalCount}</span>
              </span>
              <span className="text-[9px] text-[var(--color-text-muted)]">
                ALERTS <span className="text-[10px] text-[#4a8a6a]">{agent.alertCount}</span>
              </span>
            </div>
          )}
          {isAC && (
            <span className="text-[9px] text-[var(--color-text-muted)]">
              VERDICTS <span className="text-[10px] text-[#4a8a6a]">{confluence.length}</span>
            </span>
          )}
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

          {/* Col 1 — How it works + inputs/indicators */}
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
                {isAC ? "Inputs" : "Indicators"}
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

          {/* Col 2 — Scoring logic / reasoning steps */}
          <div>
            <p className="text-[8px] font-semibold tracking-widest text-[var(--color-text-dim)] uppercase mb-[5px]">
              {isAC ? "Scoring Logic" : "Reasoning Steps"}
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

          {/* Col 3 — Verdict types / signal outputs + notes */}
          <div className="space-y-[12px]">
            <div>
              <p className="text-[8px] font-semibold tracking-widest text-[var(--color-text-dim)] uppercase mb-[5px]">
                {isAC ? "Verdict Types" : "Signal Outputs"}
              </p>
              <div className="space-y-[5px]">
                {meta.signalTypes.map(({ type, color, condition }) => (
                  <div key={type} className="flex items-start gap-[8px]">
                    <span
                      className={`text-[9px] font-semibold flex-shrink-0 ${color}`}
                      style={{ minWidth: isAC ? "110px" : "36px" }}
                    >
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

// ─── Collapsed card ─────────────────────────────────────────────────────────

function CollapsedAgentCard({
  agent,
  confluence,
  onClick,
}: {
  agent:      Agent;
  confluence: ConfluenceResult[];
  onClick:    () => void;
}) {
  const isActive = agent.status === "active" || agent.status === "scanning";
  const isAC     = agent.id === "AC";

  const verdictSummary = isAC && confluence.length > 0
    ? confluence.map((r) => {
        const vs = VERDICT_STYLE[r.verdict] ?? { label: r.verdict, color: "text-[var(--color-text-dim)]" };
        return { symbol: r.symbol, ...vs };
      })
    : [];

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

      {isAC ? (
        verdictSummary.length > 0 ? (
          <div className="space-y-[3px]">
            {verdictSummary.map(({ symbol, label, color }) => (
              <div key={symbol} className="flex items-center justify-between">
                <span className="text-[9px] text-[var(--color-text-muted)]">{symbol}</span>
                <span className={`text-[9px] font-semibold ${color}`}>{label}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[9px] text-[var(--color-text-dim)] opacity-40">
            Awaiting refresh…
          </div>
        )
      ) : (
        <div className="flex gap-3">
          <div className="text-[9px] text-[var(--color-text-muted)]">
            SIGNALS <span className="text-[10px] text-[#4a8a6a]">{agent.signalCount}</span>
          </div>
          <div className="text-[9px] text-[var(--color-text-muted)]">
            ALERTS <span className="text-[10px] text-[#4a8a6a]">{agent.alertCount}</span>
          </div>
        </div>
      )}

      <div className="mt-[6px] pt-[6px] border-t border-[var(--color-border-subtle)] text-[8px] text-[var(--color-text-dim)]">
        {agent.lastAction}
      </div>
    </div>
  );
}

// ─── Static AC agent definition ─────────────────────────────────────────────
// Not in config/agents.ts — no signals or alertCount to track.
// Appended to the agents array after the live merge so it renders as a sixth card.

const CONFLUENCE_AGENT: Agent = {
  id:          "AC",
  name:        "Confluence Engine",
  status:      "active",
  focus:       "Weighted verdict synthesis across all agents",
  signalCount: 0,
  alertCount:  0,
  lastAction:  "Awaiting next refresh cycle…",
};

// ─── Main component ────────────────────────────────────────────────────────

export function LiveAgentGrid() {
  const [agents, setAgents]         = useState<Agent[]>([...AGENTS, CONFLUENCE_AGENT]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confluence, setConfluence] = useState<ConfluenceResult[]>([]);

  async function fetchAndMerge() {
    try {
      const res  = await fetch("/api/signals");
      const data = (await res.json()) as SignalsResponse;
      if (data.agentResults?.length) {
        setAgents([...mergeAgents(AGENTS, data.agentResults), {
          ...CONFLUENCE_AGENT,
          lastAction: data.confluence?.length
            ? `${data.confluence.length} verdict${data.confluence.length !== 1 ? "s" : ""} issued this cycle`
            : "Awaiting next refresh cycle…",
          status: data.confluence?.length ? "active" : "scanning",
        }]);
      }
      if (data.confluence) {
        setConfluence(data.confluence);
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

  useEffect(() => {
    function onSignalsUpdate(e: Event) {
      const data = (e as CustomEvent).detail as SignalsResponse;
      if (data.agentResults?.length) {
        setAgents([...mergeAgents(AGENTS, data.agentResults), {
          ...CONFLUENCE_AGENT,
          lastAction: data.confluence?.length
            ? `${data.confluence.length} verdict${data.confluence.length !== 1 ? "s" : ""} issued this cycle`
            : "Awaiting next refresh cycle…",
          status: data.confluence?.length ? "active" : "scanning",
        }]);
      }
      if (data.confluence) {
        setConfluence(data.confluence);
      }
    }
    window.addEventListener("signals:update", onSignalsUpdate);
    return () => window.removeEventListener("signals:update", onSignalsUpdate);
  }, []);

  const expandedAgent   = agents.find((a) => a.id === expandedId) ?? null;
  const collapsedAgents = agents.filter((a) => a.id !== expandedId);

  return (
    <div className="grid grid-cols-3 gap-[10px]">

      {expandedAgent && (
        <ExpandedAgentCard
          agent={expandedAgent}
          confluence={confluence}
          onClose={() => setExpandedId(null)}
        />
      )}

      {collapsedAgents.map((agent) => (
        <CollapsedAgentCard
          key={agent.id}
          agent={agent}
          confluence={confluence}
          onClick={() => setExpandedId((prev) => (prev === agent.id ? null : agent.id))}
        />
      ))}
    </div>
  );
}
