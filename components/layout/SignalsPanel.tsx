"use client";

/**
 * components/layout/SignalsPanel.tsx
 *
 * Displays clean 1-sentence signal cards.
 * Clicking a card opens SignalDetailPanel with full reasoning + raw data.
 *
 * RichCard is exported so SignalDetailPanel can import the type.
 */

import { useEffect, useState }      from "react";
import type { Signal }              from "@/lib/signals";
import type { IndicatorValues }     from "@/lib/taapi";
import { SIGNALS_POLL_MS }          from "@/config/polling";
import { SignalDetailPanel }        from "@/components/layout/SignalDetailPanel";

// ─── Types ─────────────────────────────────────────────────────────────────

interface AgentResult {
  id:          string;
  name:        string;
  signalCount: number;
  signals:     Signal[];
}

interface SignalsApiResponse {
  agentResults: AgentResult[];
  // Cache timestamp injected by /api/signals/route.ts
  cacheLastUpdated?: string;
}

/** Full data shape passed to SignalDetailPanel — export for the panel to import */
export interface RichCard {
  // Card display
  symbol:         string;
  type:           "buy" | "sell" | "watch" | "warn";
  agent:          string;
  confidence:     number;       // numeric 0-100
  confidenceLabel: string;      // "high" | "medium" | "low"
  timeLabel:      string;

  // Summary (1-sentence — shown on card)
  summary:        string;

  // Detail panel fields
  classification: string | null;
  fullReasoning:  string | null;
  keyFactors:     string[];

  // Raw indicator + derived data
  indicators:     IndicatorValues | null;
  derived:        {
    priceAboveEma20: boolean | null;
    ema20Slope:      number  | null;
    ema20PctDist:    number  | null;
    histChange:      number  | null;
    rsiChange:       number  | null;
  } | null;

  // Meta
  cacheTimestamp: string | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const TYPE_STYLES: Record<string, { label: string; color: string }> = {
  buy:   { label: "BUY",   color: "text-[var(--color-accent-green)]"  },
  sell:  { label: "SELL",  color: "text-[var(--color-accent-red)]"    },
  watch: { label: "WATCH", color: "text-[var(--color-accent-blue)]"   },
  warn:  { label: "WARN",  color: "text-[var(--color-accent-orange)]" },
};

const CONFIDENCE_MAP: Record<string, number> = {
  high:   88,
  medium: 64,
  low:    42,
};

/**
 * Extract classification from reason string.
 * Momentum Scout AI prefixes reason with "[classification] ..."
 */
function extractClassification(reason: string): string | null {
  const match = reason.match(/^\[([^\]]+)\]/);
  return match ? match[1] : null;
}

/**
 * Extract the 1-sentence summary from the reason string.
 * Format: "[classification] <reasoning> — <key_factors>"
 * We want just the reasoning sentence, before the " — " separator.
 */
function extractSummary(reason: string): string {
  // Strip leading [classification] tag
  const withoutTag = reason.replace(/^\[[^\]]+\]\s*/, "");
  // Take only the first sentence (up to first period or the " — " key_factors separator)
  const beforeFactors = withoutTag.split(" — ")[0];
  const firstSentence = beforeFactors.split(/\.\s/)[0];
  return firstSentence.trim();
}

/**
 * Extract full reasoning (everything before the " — key_factors" section).
 */
function extractReasoning(reason: string): string {
  const withoutTag = reason.replace(/^\[[^\]]+\]\s*/, "");
  return withoutTag.split(" — ")[0].trim();
}

/**
 * Extract key factors array from the reason string.
 * They are joined with "; " after the " — " separator.
 */
function extractKeyFactors(reason: string): string[] {
  const parts = reason.split(" — ");
  if (parts.length < 2) return [];
  return parts[1].split(";").map((s) => s.trim()).filter(Boolean);
}

function signalsToRichCards(
  agentResults:     AgentResult[],
  cacheTimestamp:   string | null,
  indicatorMap:     Map<string, IndicatorValues>,
  derivedMap:       Map<string, RichCard["derived"]>,
): RichCard[] {
  const cards: RichCard[] = [];
  let offsetMin = 0;

  for (const agent of agentResults) {
    for (const sig of agent.signals) {
      if (sig.type === "none") continue;

      cards.push({
        symbol:          sig.symbol,
        type:            sig.type as RichCard["type"],
        agent:           sig.agent,
        confidence:      CONFIDENCE_MAP[sig.confidence] ?? 50,
        confidenceLabel: sig.confidence,
        timeLabel:       offsetMin === 0 ? "now" : `${offsetMin}m ago`,

        summary:         extractSummary(sig.reason),
        classification:  extractClassification(sig.reason),
        fullReasoning:   extractReasoning(sig.reason),
        keyFactors:      extractKeyFactors(sig.reason),

        indicators:      indicatorMap.get(sig.symbol) ?? null,
        derived:         derivedMap.get(sig.symbol)   ?? null,
        cacheTimestamp,
      });

      offsetMin += 2;
    }
  }

  const ORDER: Record<string, number> = { buy: 0, sell: 1, watch: 2, warn: 3 };
  return cards
    .sort((a, b) => (ORDER[a.type] - ORDER[b.type]) || (b.confidence - a.confidence))
    .slice(0, 12);
}

// ─── Component ─────────────────────────────────────────────────────────────

export function SignalsPanel() {
  const [cards, setCards]         = useState<RichCard[]>([]);
  const [loading, setLoading]     = useState(true);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [selected, setSelected]   = useState<RichCard | null>(null);

  async function fetchSignals() {
    try {
      const [signalsRes, cacheRes] = await Promise.all([
        fetch("/api/signals"),
        fetch("/api/cache"),
      ]);

      const signalsData = (await signalsRes.json()) as SignalsApiResponse;
      const cacheData   = await cacheRes.json() as {
        lastUpdated: string | null;
        // Per-symbol indicator + derived snapshots injected by /api/cache
        indicators?: Record<string, IndicatorValues>;
        derived?:    Record<string, RichCard["derived"]>;
      };

      if (signalsData.agentResults) {
        const indicatorMap = new Map<string, IndicatorValues>(
          Object.entries(cacheData.indicators ?? {})
        );
        const derivedMap = new Map<string, RichCard["derived"]>(
          Object.entries(cacheData.derived ?? {})
        );

        setCards(signalsToRichCards(
          signalsData.agentResults,
          cacheData.lastUpdated,
          indicatorMap,
          derivedMap,
        ));
        setLastFetch(Date.now());
      }
    } catch (err) {
      console.error("[SignalsPanel] fetch error", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSignals();
    const id = setInterval(fetchSignals, SIGNALS_POLL_MS);
    return () => clearInterval(id);
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
              <p className="text-[8px] text-[var(--color-text-dim)] opacity-30 mt-[4px]">Waiting for indicator data…</p>
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
                  {/* Symbol + type */}
                  <div className="flex items-center justify-between mb-[4px]">
                    <span className="text-[12px] font-medium text-[var(--color-text-primary)]">{card.symbol}</span>
                    <span className={`text-[9px] font-semibold tracking-wide ${style.color}`}>{style.label}</span>
                  </div>

                  {/* 1-sentence summary */}
                  <p className="text-[10px] text-[var(--color-text-secondary)] leading-[1.4] mb-[5px] line-clamp-2">
                    {card.summary}
                  </p>

                  {/* Agent + confidence */}
                  <div className="flex items-center justify-between mb-[2px]">
                    <span className="text-[9px] text-[var(--color-text-dim)]">{card.agent}</span>
                    <span className="text-[9px] text-[var(--color-text-dim)]">{card.confidence}%</span>
                  </div>

                  {/* Confidence bar */}
                  <div className="h-[2px] w-full bg-[var(--color-border-default)] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent-green)] opacity-60"
                      style={{ width: `${card.confidence}%` }}
                    />
                  </div>

                  {/* Time + tap hint */}
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

      {/* Slide-over detail panel — rendered outside aside so it overlays full screen */}
      <SignalDetailPanel
        card={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}