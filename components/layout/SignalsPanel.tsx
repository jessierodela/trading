"use client";

/**
 * components/layout/SignalsPanel.tsx
 * Polls /api/signals every 60s and renders live agent signals as alert cards.
 * No longer receives static ALERTS prop — data comes from the signals pipeline.
 */

import { useEffect, useState } from "react";
import type { Signal } from "@/lib/signals";

// ─── Types ────────────────────────────────────────────────────────────────

interface AgentResult {
  id:          string;
  name:        string;
  signalCount: number;
  signals:     Signal[];
}

interface SignalsApiResponse {
  agentResults: AgentResult[];
}

// Flattened display card derived from Signal
interface AlertCard {
  symbol:     string;
  type:       "buy" | "sell" | "watch" | "warn";
  message:    string;
  agent:      string;
  confidence: number; // 0–100
  timeLabel:  string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const TYPE_STYLES: Record<AlertCard["type"], { label: string; color: string }> = {
  buy:   { label: "BUY",   color: "text-[var(--color-accent-green)]"  },
  sell:  { label: "SELL",  color: "text-[var(--color-accent-red)]"    },
  watch: { label: "WATCH", color: "text-[var(--color-accent-blue)]"   },
  warn:  { label: "WARN",  color: "text-[var(--color-accent-orange)]" },
};

const CONFIDENCE_MAP: Record<Signal["confidence"], number> = {
  high:   88,
  medium: 64,
  low:    42,
};

function signalsToCards(agentResults: AgentResult[]): AlertCard[] {
  const cards: AlertCard[] = [];
  let offsetMin = 0;

  for (const agent of agentResults) {
    for (const sig of agent.signals) {
      if (sig.type === "none") continue;

      const confPct = CONFIDENCE_MAP[sig.confidence] ?? 50;
      const timeLabel = offsetMin === 0 ? "now" : `${offsetMin}m ago`;

      cards.push({
        symbol:     sig.symbol,
        type:       sig.type === "sell" ? "sell" : sig.type as AlertCard["type"],
        message:    sig.reason,
        agent:      sig.agent,
        confidence: confPct,
        timeLabel,
      });

      offsetMin += 2;
    }
  }

  // Sort: buy > sell > watch, then by confidence desc
  const ORDER = { buy: 0, sell: 1, watch: 2, warn: 3 };
  return cards
    .sort((a, b) => (ORDER[a.type] - ORDER[b.type]) || (b.confidence - a.confidence))
    .slice(0, 12);
}

// ─── Component ────────────────────────────────────────────────────────────

export function SignalsPanel() {
  const [cards, setCards]     = useState<AlertCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState<number | null>(null);

  async function fetchSignals() {
    try {
      const res  = await fetch("/api/signals");
      const data = (await res.json()) as SignalsApiResponse;
      if (data.agentResults) {
        setCards(signalsToCards(data.agentResults));
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
    const id = setInterval(fetchSignals, 60_000);
    return () => clearInterval(id);
  }, []);

  // Build age label for the header
  const ageLabel = lastFetch
    ? `${Math.round((Date.now() - lastFetch) / 1000)}s ago`
    : null;

  return (
    <aside className="w-[200px] shrink-0 border-l border-[var(--color-border-default)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-[14px] py-[10px] border-b border-[var(--color-border-default)] shrink-0 flex items-center gap-[6px]">
        <span className="w-[5px] h-[5px] rounded-full bg-[var(--color-accent-green)] opacity-80" />
        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.14em] flex-1">SIGNALS</span>
        {ageLabel && (
          <span className="text-[8px] text-[var(--color-text-dim)] opacity-40">{ageLabel}</span>
        )}
      </div>

      {/* Content */}
      <div className="overflow-y-auto flex-1">
        {loading ? (
          // Skeleton placeholders while first fetch is in flight
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
                className="px-[14px] py-[10px] border-b border-[var(--color-border-default)] last:border-b-0"
              >
                {/* Symbol + badge */}
                <div className="flex items-center justify-between mb-[4px]">
                  <span className="text-[12px] font-medium text-[var(--color-text-primary)]">
                    {card.symbol}
                  </span>
                  <span className={`text-[9px] font-semibold tracking-wide ${style.color}`}>
                    {style.label}
                  </span>
                </div>

                {/* Reasoning message */}
                <p className="text-[10px] text-[var(--color-text-secondary)] leading-[1.4] mb-[5px]">
                  {card.message}
                </p>

                {/* Agent + confidence % */}
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

                {/* Timestamp */}
                <div className="mt-[4px]">
                  <span className="text-[9px] text-[var(--color-text-dim)] opacity-50">
                    {card.timeLabel}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
