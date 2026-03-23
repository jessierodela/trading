"use client";

/**
 * components/layout/SignalDetailPanel.tsx
 *
 * Slide-over panel that renders from the right when a signal card is clicked.
 * Receives the full RichCard object — no additional fetch needed.
 *
 * Handles two card types:
 *  1. Regular agent signal cards — shows reasoning, key factors, indicators, derived
 *  2. Confluence cards (card.confluenceData present) — shows verdict, narrative,
 *     agent vote breakdown, score bar, and tags
 *
 * CHANGE LOG:
 *  - Added confluence card rendering path — detects card.confluenceData and
 *    renders the full verdict detail view instead of indicator rows.
 */

import { useEffect } from "react";
import type { RichCard } from "@/components/layout/SignalsPanel";

interface Props {
  card:    RichCard | null;
  onClose: () => void;
}

const TYPE_STYLES: Record<string, { label: string; color: string; bar: string }> = {
  buy:   { label: "BUY",   color: "text-[var(--color-accent-green)]",  bar: "bg-[var(--color-accent-green)]"  },
  sell:  { label: "SELL",  color: "text-[var(--color-accent-red)]",    bar: "bg-[var(--color-accent-red)]"    },
  watch: { label: "WATCH", color: "text-[var(--color-accent-blue)]",   bar: "bg-[var(--color-accent-blue)]"   },
  warn:  { label: "WARN",  color: "text-[var(--color-accent-orange)]", bar: "bg-[var(--color-accent-orange)]" },
};

const VERDICT_STYLES: Record<string, { color: string; bar: string }> = {
  aligned_bullish:      { color: "text-[var(--color-accent-green)]",  bar: "bg-[var(--color-accent-green)]"   },
  bullish_but_extended: { color: "text-[var(--color-accent-blue)]",   bar: "bg-[var(--color-accent-blue)]"    },
  mixed_structure:      { color: "text-[var(--color-accent-orange)]", bar: "bg-[var(--color-accent-blue)]"    },
  bearish_structure:    { color: "text-[var(--color-accent-red)]",    bar: "bg-[var(--color-accent-red)]"     },
  countertrend_only:    { color: "text-[var(--color-accent-orange)]", bar: "bg-[var(--color-accent-orange)]"  },
  no_trade:             { color: "text-[var(--color-text-dim)]",      bar: "bg-[var(--color-border-default)]" },
};

const VOTE_COLOR: Record<string, string> = {
  buy:     "text-[var(--color-accent-green)]",
  sell:    "text-[var(--color-accent-red)]",
  watch:   "text-[var(--color-accent-blue)]",
  neutral: "text-[var(--color-text-dim)]",
};

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="flex items-baseline justify-between py-[5px] border-b border-[var(--color-border-default)] last:border-b-0">
      <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.1em]">{label}</span>
      <span className="text-[10px] text-[var(--color-text-secondary)] tabular-nums font-mono">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-[18px]">
      <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.18em] mb-[8px] opacity-60">{title}</p>
      {children}
    </div>
  );
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(decimals);
}

// ─── Confluence detail view ─────────────────────────────────────────────────

function ConfluenceDetail({ card }: { card: RichCard }) {
  const cd = card.confluenceData!;
  const vs = VERDICT_STYLES[cd.verdict] ?? VERDICT_STYLES.no_trade;
  const scoreNorm = Math.round(((cd.weightedScore + 8) / 16) * 100);
  const verdictLabel = cd.verdict.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <>
      {/* Verdict + score */}
      <Section title="VERDICT">
        <div className="flex items-center justify-between mb-[6px]">
          <span className={`text-[12px] font-semibold ${vs.color}`}>{verdictLabel}</span>
          <span className="text-[10px] text-[var(--color-text-dim)] tabular-nums font-mono">
            {cd.weightedScore > 0 ? "+" : ""}{cd.weightedScore}
          </span>
        </div>
        {/* Score bar — range -8 to +8 */}
        <div className="h-[3px] w-full bg-[var(--color-border-default)] rounded-full overflow-hidden mb-[4px]">
          <div
            className={`h-full rounded-full ${vs.bar} opacity-70`}
            style={{ width: `${scoreNorm}%` }}
          />
        </div>
        <p className="text-[8px] text-[var(--color-text-dim)] opacity-50">
          Score range −8 to +8 · gate: Momentum Scout + Trend Follower
        </p>
      </Section>

      {/* Narrative */}
      <Section title="CONFLUENCE NARRATIVE">
        <p className="text-[11px] text-[var(--color-text-secondary)] leading-[1.7]">
          {cd.narrative}
        </p>
      </Section>

      {/* Agent vote breakdown */}
      {cd.agentVotes.length > 0 && (
        <Section title="AGENT VOTES">
          <div className="space-y-[6px]">
            {cd.agentVotes.map((v) => {
              const voteColor = VOTE_COLOR[v.signal] ?? "text-[var(--color-text-dim)]";
              const confMult  = v.confidence === "high" ? 1.0 : v.confidence === "medium" ? 0.7 : 0.4;
              return (
                <div key={v.agent} className="flex items-center justify-between py-[4px] border-b border-[var(--color-border-default)] last:border-b-0">
                  <span className="text-[10px] text-[var(--color-text-secondary)]">{v.agent}</span>
                  <div className="flex items-center gap-[10px]">
                    <span className={`text-[9px] font-semibold uppercase ${voteColor}`}>{v.signal}</span>
                    <span className="text-[9px] text-[var(--color-text-dim)] opacity-60 tabular-nums font-mono w-[28px] text-right">
                      {v.score > 0 ? "+" : ""}{v.score.toFixed(1)}
                    </span>
                    <span className="text-[8px] text-[var(--color-text-dim)] opacity-40 tabular-nums w-[28px] text-right">
                      {v.confidence}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Tags */}
      {cd.tags.length > 0 && (
        <Section title="FLAGS">
          <div className="flex flex-wrap gap-[5px]">
            {cd.tags.map((tag) => (
              <span
                key={tag}
                className="text-[9px] border border-[var(--color-border-default)] rounded-[3px] px-[6px] py-[2px] text-[var(--color-text-secondary)]"
              >
                {tag.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* Hard conflict warning */}
      {cd.hasHardConflict && (
        <div className="mb-[18px] px-[10px] py-[8px] border border-[var(--color-accent-orange)] rounded-[4px] border-opacity-40">
          <p className="text-[9px] text-[var(--color-accent-orange)] leading-[1.5]">
            ⚠ Hard conflict detected — Momentum Scout and Trend Follower disagree on direction. No trade until resolved.
          </p>
        </div>
      )}

      {/* Meta */}
      <Section title="META">
        <Row label="Agent"         value="Confluence Engine"        />
        <Row label="Cache updated" value={formatTs(card.cacheTimestamp)} />
      </Section>
    </>
  );
}

// ─── Main panel ─────────────────────────────────────────────────────────────

export function SignalDetailPanel({ card, onClose }: Props) {
  const open        = card !== null;
  const isConfluence = card?.confluenceData != null;

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const style   = card && !isConfluence ? (TYPE_STYLES[card.type] ?? TYPE_STYLES.watch) : TYPE_STYLES.watch;
  const ind     = card?.indicators;
  const derived = card?.derived;

  // Header badge — verdict label for confluence, signal type for agents
  const headerBadgeLabel = isConfluence
    ? (card?.confluenceData?.verdict.replace(/_/g, " ") ?? "")
    : style.label;
  const headerBadgeColor = isConfluence
    ? (VERDICT_STYLES[card?.confluenceData?.verdict ?? ""]?.color ?? "text-[var(--color-text-dim)]")
    : style.color;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={[
          "fixed inset-0 z-40 bg-black transition-opacity duration-200",
          open ? "opacity-30 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
      />

      {/* Slide-over */}
      <aside
        className={[
          "fixed top-0 right-0 h-full z-50 flex flex-col",
          "w-[320px] bg-[var(--color-surface-panel)] border-l border-[var(--color-border-default)]",
          "transition-transform duration-250 ease-in-out",
          open ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-[16px] py-[12px] border-b border-[var(--color-border-default)] shrink-0">
          <div className="flex items-center gap-[8px]">
            <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
              {card?.symbol ?? "—"}
            </span>
            {card && (
              <span className={`text-[9px] font-semibold tracking-[.1em] capitalize ${headerBadgeColor}`}>
                {headerBadgeLabel}
              </span>
            )}
            {!isConfluence && card?.classification && (
              <span className="text-[8px] text-[var(--color-text-dim)] opacity-60 tracking-[.1em] border border-[var(--color-border-default)] px-[5px] py-[1px] rounded-[3px]">
                {card.classification.replace(/_/g, " ")}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-text-dim)] hover:text-[var(--color-text-primary)] text-[16px] leading-none opacity-60 hover:opacity-100 transition-opacity"
          >
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-[16px] py-[14px]">

          {/* ── Confluence card path ── */}
          {isConfluence && card && <ConfluenceDetail card={card} />}

          {/* ── Agent signal card path ── */}
          {!isConfluence && (
            <>
              {/* Confidence */}
              {card && (
                <Section title="CONFIDENCE">
                  <div className="flex items-center justify-between mb-[5px]">
                    <span className="text-[10px] text-[var(--color-text-secondary)] capitalize">{card.confidenceLabel}</span>
                    <span className="text-[10px] text-[var(--color-text-dim)] tabular-nums">{card.confidence}%</span>
                  </div>
                  <div className="h-[2px] w-full bg-[var(--color-border-default)] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${style.bar} opacity-70`}
                      style={{ width: `${card.confidence}%` }}
                    />
                  </div>
                </Section>
              )}

              {/* Reasoning */}
              {card?.fullReasoning && (
                <Section title="REASONING">
                  <p className="text-[11px] text-[var(--color-text-secondary)] leading-[1.6]">
                    {card.fullReasoning}
                  </p>
                </Section>
              )}

              {/* Key factors */}
              {card?.keyFactors && card.keyFactors.length > 0 && (
                <Section title="KEY FACTORS">
                  <ul className="space-y-[6px]">
                    {card.keyFactors.map((f, i) => (
                      <li key={i} className="flex items-start gap-[6px]">
                        <span className={`text-[8px] mt-[2px] ${style.color}`}>▸</span>
                        <span className="text-[10px] text-[var(--color-text-secondary)] leading-[1.5]">{f}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {/* Raw indicators */}
              {ind && (
                <Section title="INDICATORS">
                  <Row label="RSI"         value={fmt(ind.rsi)}                              />
                  <Row label="MACD"        value={fmt(ind.macd?.valueMACD, 4)}               />
                  <Row label="MACD Signal" value={fmt(ind.macd?.valueMACDSignal, 4)}         />
                  <Row label="MACD Hist"   value={fmt(ind.macd?.valueMACDHist, 6)}           />
                  <Row label="EMA20"       value={ind.ema20 ? `$${fmt(ind.ema20)}` : null}   />
                  <Row label="Close"       value={ind.currentClose ? `$${fmt(ind.currentClose)}` : null} />
                  <Row label="ATR"         value={fmt(ind.atr, 4)}                           />
                </Section>
              )}

              {/* Derived fields */}
              {derived && (
                <Section title="DERIVED">
                  <Row label="Price above EMA20" value={derived.priceAboveEma20 === null ? "—" : derived.priceAboveEma20 ? "Yes" : "No"} />
                  <Row label="EMA20 slope"       value={fmt(derived.ema20Slope, 4)}     />
                  <Row label="EMA20 dist %"      value={derived.ema20PctDist != null ? `${fmt(derived.ema20PctDist)}%` : null} />
                  <Row label="Hist change"       value={fmt(derived.histChange, 6)}     />
                  <Row label="RSI change"        value={fmt(derived.rsiChange, 2)}      />
                  <Row label="Prev RSI"          value={fmt(ind?.prevRsi, 1)}           />
                  <Row label="Prev MACD hist"    value={fmt(ind?.prevHist, 6)}          />
                </Section>
              )}

              {/* Meta */}
              {card && (
                <Section title="META">
                  <Row label="Agent"         value={card.agent}                         />
                  <Row label="Cache updated" value={formatTs(card.cacheTimestamp)}      />
                  <Row label="Time"          value={card.timeLabel}                     />
                </Section>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
