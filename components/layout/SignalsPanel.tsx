"use client";

/**
 * components/layout/SignalsPanel.tsx
 *
 * Displays confluence verdicts and signal cards from the last agent run.
 * Updates via two paths:
 *   1. "signals:update" event dispatched by RefreshButton (instant)
 *   2. Polling /api/signals every SIGNALS_POLL_MS (catches other instances)
 *
 * CHANGE LOG:
 *  - Added confluence[] to SignalsPayload type.
 *  - Added ConfluenceSection rendered above signal cards.
 *  - applyPayload now reads and stores confluence results.
 */

import { useEffect, useState, useCallback } from "react";
import type { Signal }                      from "@/lib/signals";
import type { IndicatorValues }             from "@/lib/taapi";
import { SignalDetailPanel }                from "@/components/layout/SignalDetailPanel";

// ─── Types ─────────────────────────────────────────────────────────────────

interface AgentResult {
  id:          string;
  name:        string;
  signalCount: number;
  signals:     Signal[];
}

interface ConfluenceResult {
  symbol:        string;
  verdict:       string;
  weightedScore: number;
  narrative:     string;
  tags:          string[];
  gateMet:       boolean;
  hasHardConflict: boolean;
}

interface SignalsPayload {
  agentResults: AgentResult[];
  confluence?:  ConfluenceResult[];
  generatedAt:  string | null;
  indicators?:  Record<string, IndicatorValues>;
  derived?:     Record<string, RichCard["derived"]>;
}

export interface RichCard {
  symbol:          string;
  type:            "buy" | "sell" | "watch" | "warn" | "neutral";
  agent:           string;
  confidence:      number;
  confidenceLabel: string;
  timeLabel:       string;
  summary:         string;
  classification:  string | null;
  fullReasoning:   string | null;
  keyFactors:      string[];
  indicators:      IndicatorValues | null;
  derived:         {
    priceAboveEma20: boolean | null;
    ema20Slope:      number  | null;
    ema20PctDist:    number  | null;
    histChange:      number  | null;
    rsiChange:       number  | null;
  } | null;
  cacheTimestamp:  string | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const TYPE_STYLES: Record<string, { label: string; color: string }> = {
  buy:     { label: "BUY",     color: "text-[var(--color-accent-green)]"  },
  sell:    { label: "SELL",    color: "text-[var(--color-accent-red)]"    },
  watch:   { label: "WATCH",   color: "text-[var(--color-accent-blue)]"   },
  warn:    { label: "WARN",    color: "text-[var(--color-accent-orange)]" },
  neutral: { label: "NEUTRAL", color: "text-[var(--color-text-dim)]"      },
};

const VERDICT_STYLES: Record<string, { label: string; color: string; barColor: string }> = {
  aligned_bullish:      { label: "Aligned Bullish",    color: "text-[var(--color-accent-green)]",  barColor: "bg-[var(--color-accent-green)]"  },
  bullish_but_extended: { label: "Bullish / Extended", color: "text-[var(--color-accent-blue)]",   barColor: "bg-[var(--color-accent-blue)]"   },
  mixed_structure:      { label: "Mixed Structure",    color: "text-[var(--color-accent-orange)]", barColor: "bg-[var(--color-accent-blue)]"   },
  bearish_structure:    { label: "Bearish Structure",  color: "text-[var(--color-accent-red)]",    barColor: "bg-[var(--color-accent-red)]"    },
  countertrend_only:    { label: "Countertrend",       color: "text-[var(--color-accent-orange)]", barColor: "bg-[var(--color-accent-orange)]" },
  no_trade:             { label: "No Trade",           color: "text-[var(--color-text-dim)]",      barColor: "bg-[var(--color-border-default)]"},
};

const CONFIDENCE_MAP: Record<string, number> = { high: 88, medium: 64, low: 42 };

function extractClassification(reason: string): string | null {
  const match = reason.match(/^\[([^\]]+)\]/);
  return match ? match[1] : null;
}

function extractSummary(reason: string): string {
  return reason.replace(/^\[[^\]]+\]\s*/, "").split(" — ")[0].split(/\.\s/)[0].trim();
}

function extractReasoning(reason: string): string {
  return reason.replace(/^\[[^\]]+\]\s*/, "").split(" — ")[0].trim();
}

function extractKeyFactors(reason: string): string[] {
  const parts = reason.split(" — ");
  if (parts.length < 2) return [];
  return parts[1].split(";").map((s) => s.trim()).filter(Boolean);
}

function buildCards(payload: SignalsPayload): RichCard[] {
  const cards: RichCard[] = [];
  let offsetMin = 0;

  for (const agent of payload.agentResults) {
    for (const sig of agent.signals) {
      if (sig.type === "none") continue;
      cards.push({
        symbol:          sig.symbol,
        type:            (sig.type === "neutral" ? "neutral" : sig.type) as RichCard["type"],
        agent:           sig.agent,
        confidence:      CONFIDENCE_MAP[sig.confidence] ?? 50,
        confidenceLabel: sig.confidence,
        timeLabel:       offsetMin === 0 ? "now" : `${offsetMin}m ago`,
        summary:         extractSummary(sig.reason),
        classification:  extractClassification(sig.reason),
        fullReasoning:   extractReasoning(sig.reason),
        keyFactors:      extractKeyFactors(sig.reason),
        indicators:      null,
        derived:         null,
        cacheTimestamp:  payload.generatedAt,
      });
      offsetMin += 2;
    }
  }

  const ORDER: Record<string, number> = { buy: 0, sell: 1, watch: 2, warn: 3, neutral: 4 };
  return cards
    .sort((a, b) => (ORDER[a.type] - ORDER[b.type]) || (b.confidence - a.confidence))
    .slice(0, 12);
}

// ─── Confluence section ─────────────────────────────────────────────────────
// Rendered at the top of the panel, above signal cards.
// One compact row per symbol showing verdict label + narrative.

function ConfluenceSection({ results }: { results: ConfluenceResult[] }) {
  if (results.length === 0) return null;

  return (
    <div className="border-b border-[var(--color-border-default)]">
      {/* Section label */}
      <div className="px-[14px] py-[6px] flex items-center gap-[5px]">
        <span className="w-[4px] h-[4px] rounded-full bg-[var(--color-accent-blue)] opacity-70" />
        <span className="text-[8px] tracking-[.14em] text-[var(--color-text-dim)] uppercase">
          Confluence
        </span>
      </div>

      {/* One row per symbol */}
      {results.map((r) => {
        const vs = VERDICT_STYLES[r.verdict] ?? VERDICT_STYLES.no_trade;
        const scoreNorm = Math.round(((r.weightedScore + 8) / 16) * 100);

        return (
          <div
            key={r.symbol}
            className="px-[14px] pb-[10px] border-b border-[var(--color-border-subtle)] last:border-b-0"
          >
            {/* Symbol + verdict */}
            <div className="flex items-center justify-between mb-[4px]">
              <span className="text-[11px] font-medium text-[var(--color-text-primary)]">
                {r.symbol}
              </span>
              <span className={`text-[8px] font-semibold tracking-wide ${vs.color}`}>
                {vs.label}
              </span>
            </div>

            {/* Score bar */}
            <div className="h-[2px] w-full bg-[var(--color-border-default)] rounded-full overflow-hidden mb-[5px]">
              <div
                className={`h-full rounded-full ${vs.barColor} opacity-60`}
                style={{ width: `${scoreNorm}%` }}
              />
            </div>

            {/* Narrative */}
            <p className="text-[9px] text-[var(--color-text-secondary)] leading-[1.45] mb-[4px]">
              {r.narrative}
            </p>

            {/* Tags */}
            {r.tags.length > 0 && (
              <div className="flex flex-wrap gap-[3px]">
                {r.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-[7px] border border-[var(--color-border-default)] rounded-[2px] px-[3px] py-[1px] text-[var(--color-text-dim)]"
                  >
                    {tag.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

export function SignalsPanel() {
  const [cards, setCards]           = useState<RichCard[]>([]);
  const [confluence, setConfluence] = useState<ConfluenceResult[]>([]);
  const [loading, setLoading]       = useState(true);
  const [lastFetch, setLastFetch]   = useState<number | null>(null);
  const [selected, setSelected]     = useState<RichCard | null>(null);

  const applyPayload = useCallback((
    payload: SignalsPayload,
    indicatorMap?: Map<string, IndicatorValues>,
    derivedMap?:   Map<string, RichCard["derived"]>,
  ) => {
    if (payload.agentResults) {
      const cards = buildCards(payload);
      if (indicatorMap || derivedMap) {
        for (const card of cards) {
          if (indicatorMap) card.indicators = indicatorMap.get(card.symbol) ?? null;
          if (derivedMap)   card.derived    = derivedMap.get(card.symbol)   ?? null;
        }
      }
      setCards(cards);
      setLastFetch(Date.now());
    }
    if (payload.confluence) {
      setConfluence(payload.confluence);
    }
    setLoading(false);
  }, []);

  async function poll() {
    try {
      const [signalsRes, cacheRes] = await Promise.all([
        fetch("/api/signals"),
        fetch("/api/cache"),
      ]);
      const data      = await signalsRes.json() as SignalsPayload;
      const cacheData = await cacheRes.json() as {
        indicators?: Record<string, IndicatorValues>;
        derived?:    Record<string, RichCard["derived"]>;
      };

      const indicatorMap = cacheData.indicators
        ? new Map(Object.entries(cacheData.indicators))
        : undefined;
      const derivedMap = cacheData.derived
        ? new Map(Object.entries(cacheData.derived))
        : undefined;

      applyPayload(data, indicatorMap, derivedMap);
    } catch (err) {
      console.error("[SignalsPanel] poll error", err);
      setLoading(false);
    }
  }

  useEffect(() => {
    poll();

    function onUpdate(e: Event) {
      const payload = (e as CustomEvent<SignalsPayload>).detail;
      const indicatorMap = payload.indicators
        ? new Map(Object.entries(payload.indicators))
        : undefined;
      const derivedMap = payload.derived
        ? new Map(Object.entries(payload.derived))
        : undefined;
      applyPayload(payload, indicatorMap, derivedMap);
    }
    window.addEventListener("signals:update", onUpdate);
    return () => window.removeEventListener("signals:update", onUpdate);
  }, []);

  const ageLabel = lastFetch
    ? `${Math.round((Date.now() - lastFetch) / 1000)}s ago`
    : null;

  return (
    <>
      <aside className="w-[200px] shrink-0 border-l border-[var(--color-border-default)] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="px-[14px] py-[10px] border-b border-[var(--color-border-default)] shrink-0 flex items-center gap-[6px]">
          <span className="w-[5px] h-[5px] rounded-full bg-[var(--color-accent-green)] opacity-80" />
          <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.14em] flex-1">SIGNALS</span>
          {ageLabel && (
            <span className="text-[8px] text-[var(--color-text-dim)] opacity-40">{ageLabel}</span>
          )}
        </div>

        <div className="overflow-y-auto flex-1">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-[14px] py-[10px] border-b border-[var(--color-border-default)] animate-pulse">
                <div className="flex justify-between mb-[6px]">
                  <div className="h-[10px] w-[32px] bg-[var(--color-border-default)] rounded" />
                  <div className="h-[10px] w-[24px] bg-[var(--color-border-default)] rounded" />
                </div>
                <div className="h-[8px] w-full bg-[var(--color-border-default)] rounded mb-[4px]" />
                <div className="h-[8px] w-3/4 bg-[var(--color-border-default)] rounded" />
              </div>
            ))
          ) : (
            <>
              {/* Confluence verdicts — above signal cards */}
              <ConfluenceSection results={confluence} />

              {/* Signal cards */}
              {cards.length === 0 ? (
                <div className="px-[14px] py-[20px] text-center">
                  <p className="text-[9px] text-[var(--color-text-dim)] opacity-50">No signals yet</p>
                  <p className="text-[8px] text-[var(--color-text-dim)] opacity-30 mt-[4px]">Press refresh to run agents…</p>
                </div>
              ) : (
                <>
                  {/* Divider label before individual agent signals */}
                  <div className="px-[14px] py-[6px] flex items-center gap-[5px] border-b border-[var(--color-border-default)]">
                    <span className="w-[4px] h-[4px] rounded-full bg-[var(--color-accent-green)] opacity-70" />
                    <span className="text-[8px] tracking-[.14em] text-[var(--color-text-dim)] uppercase">
                      Agent Signals
                    </span>
                  </div>

                  {cards.map((card, i) => {
                    const style = TYPE_STYLES[card.type] ?? TYPE_STYLES.watch;
                    return (
                      <div
                        key={i}
                        onClick={() => setSelected(card)}
                        className="px-[14px] py-[10px] border-b border-[var(--color-border-default)] last:border-b-0 cursor-pointer hover:bg-[var(--color-surface-hover,rgba(255,255,255,0.03))] transition-colors"
                      >
                        <div className="flex items-center justify-between mb-[4px]">
                          <span className="text-[12px] font-medium text-[var(--color-text-primary)]">{card.symbol}</span>
                          <span className={`text-[9px] font-semibold tracking-wide ${style.color}`}>{style.label}</span>
                        </div>
                        <p className="text-[10px] text-[var(--color-text-secondary)] leading-[1.4] mb-[5px] line-clamp-2">
                          {card.summary}
                        </p>
                        <div className="flex items-center justify-between mb-[2px]">
                          <span className="text-[9px] text-[var(--color-text-dim)]">{card.agent}</span>
                          <span className="text-[9px] text-[var(--color-text-dim)]">{card.confidence}%</span>
                        </div>
                        <div className="h-[2px] w-full bg-[var(--color-border-default)] rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-[var(--color-accent-green)] opacity-60"
                            style={{ width: `${card.confidence}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between mt-[4px]">
                          <span className="text-[9px] text-[var(--color-text-dim)] opacity-50">{card.timeLabel}</span>
                          <span className="text-[8px] text-[var(--color-text-dim)] opacity-30">details →</span>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      </aside>

      <SignalDetailPanel card={selected} onClose={() => setSelected(null)} />
    </>
  );
}
