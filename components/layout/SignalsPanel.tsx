"use client";

/**
 * components/layout/SignalsPanel.tsx
 *
 * Displays signal cards from the last agent run.
 * Updates via two paths:
 *   1. "signals:update" event dispatched by RefreshButton (instant)
 *   2. Polling /api/signals every SIGNALS_POLL_MS (catches other instances)
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

interface SignalsPayload {
  agentResults: AgentResult[];
  generatedAt:  string | null;
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
        indicators:      null, // populated from /api/cache if needed for detail panel
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

// ─── Component ─────────────────────────────────────────────────────────────

export function SignalsPanel() {
  const [cards, setCards]       = useState<RichCard[]>([]);
  const [loading, setLoading]   = useState(true);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [selected, setSelected] = useState<RichCard | null>(null);

  const applyPayload = useCallback((
    payload: SignalsPayload,
    indicatorMap?: Map<string, IndicatorValues>,
    derivedMap?:   Map<string, RichCard["derived"]>,
  ) => {
    if (payload.agentResults) {
      const cards = buildCards(payload);
      // Overlay indicator + derived data if available
      if (indicatorMap || derivedMap) {
        for (const card of cards) {
          if (indicatorMap) card.indicators = indicatorMap.get(card.symbol) ?? null;
          if (derivedMap)   card.derived    = derivedMap.get(card.symbol)   ?? null;
        }
      }
      setCards(cards);
      setLastFetch(Date.now());
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
    // Load once on mount — picks up any warm-instance cache on page load
    poll();

    // Instant update dispatched by RefreshButton after a successful run.
    // No interval polling — polling across Vercel serverless instances returns
    // stale data from whichever old instance responds, causing inconsistent panel state.
    function onUpdate(e: Event) {
      const payload = (e as CustomEvent<SignalsPayload>).detail;
      fetch("/api/cache")
        .then((r) => r.json())
        .then((cacheData: { indicators?: Record<string, IndicatorValues>; derived?: Record<string, RichCard["derived"]> }) => {
          const indicatorMap = cacheData.indicators
            ? new Map(Object.entries(cacheData.indicators))
            : undefined;
          const derivedMap = cacheData.derived
            ? new Map(Object.entries(cacheData.derived))
            : undefined;
          applyPayload(payload, indicatorMap, derivedMap);
        })
        .catch(() => applyPayload(payload));
    }
    window.addEventListener("signals:update", onUpdate);

    return () => {
      window.removeEventListener("signals:update", onUpdate);
    };
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

        {/* Cards */}
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
          ) : cards.length === 0 ? (
            <div className="px-[14px] py-[20px] text-center">
              <p className="text-[9px] text-[var(--color-text-dim)] opacity-50">No signals yet</p>
              <p className="text-[8px] text-[var(--color-text-dim)] opacity-30 mt-[4px]">Press refresh to run agents…</p>
            </div>
          ) : (
            cards.map((card, i) => {
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
            })
          )}
        </div>
      </aside>

      <SignalDetailPanel card={selected} onClose={() => setSelected(null)} />
    </>
  );
}
