/**
 * lib/confluence/scoreSignals.ts
 *
 * Deterministic confluence scorer.
 *
 * Takes the Signal[] output from all five agents for a single symbol
 * and computes a weighted directional score + raw verdict.
 *
 * Weights reflect each agent's role in the decision hierarchy:
 *   A1 Momentum Scout    — weight 3  (primary momentum read)
 *   A2 Breakout Watcher  — weight 2  (trigger quality)
 *   A3 Trend Follower    — weight 3  (1D structural bias)
 *   A4 Volatility Arbiter — weight 2 (execution risk / veto eligible)
 *   A5 Mean Reversion    — modifier only (applied after verdict)
 *
 * Confidence multipliers:
 *   high   → 1.0
 *   medium → 0.7
 *   low    → 0.4
 *
 * Vote values:
 *   buy    → +1
 *   sell   → -1
 *   watch  → 0
 *   neutral → 0
 */

import type { Signal } from "@/lib/signals";

// ─── Types ─────────────────────────────────────────────────────────────────

export type ConfluenceVerdict =
  | "aligned_bullish"
  | "bullish_but_extended"
  | "mixed_structure"
  | "bearish_structure"
  | "countertrend_only"
  | "no_trade";

export interface AgentVote {
  agentName:  string;
  signal:     Signal["type"];
  confidence: Signal["confidence"];
  weight:     number;
  score:      number; // weight × confidence × vote direction
  tags:       string[];
}

export interface ScoringResult {
  verdict:       ConfluenceVerdict;
  weightedScore: number;          // sum of all agent scores
  votes:         AgentVote[];
  gateMet:       boolean;         // A1 + A3 both present
  hasHardConflict: boolean;       // A1 buy + A3 sell simultaneously
  a4VetoActive:  boolean;         // A4 flagged high chase/extension risk
  a5Present:     boolean;         // Mean Reversion fired
  a5Signal:      Signal["type"] | null;
}

// ─── Agent weight registry ──────────────────────────────────────────────────

const AGENT_WEIGHTS: Record<string, number> = {
  "Momentum Scout":    3,
  "Breakout Watcher":  2,
  "Trend Follower":    3,
  "Volatility Arbiter": 2,
  // Mean Reversion is not scored — it's a modifier applied post-verdict
};

const CONFIDENCE_MULTIPLIER: Record<Signal["confidence"], number> = {
  high:   1.0,
  medium: 0.7,
  low:    0.4,
};

const VOTE_DIRECTION: Record<Signal["type"], number> = {
  buy:     1,
  sell:    -1,
  watch:   0,
  neutral: 0,
  none:    0,
};

// ─── Veto detector ──────────────────────────────────────────────────────────
// A4 Volatility Arbiter can veto by signaling high chase risk or extension.
// Detected via tags on the signal — "extreme" or "high_risk" volatility regime.

const A4_VETO_TAGS = new Set([
  "extreme",
  "high_risk",
]);

function isA4Veto(signal: Signal): boolean {
  if (signal.agent !== "Volatility Arbiter") return false;
  // A4 veto only meaningful when the broader direction is bullish (chase risk)
  if (signal.type !== "watch") return false;
  return (signal.tags ?? []).some((t) => A4_VETO_TAGS.has(t));
}

// ─── Scorer ────────────────────────────────────────────────────────────────

/**
 * Score all agent signals for a single symbol.
 *
 * @param symbolSignals - All Signal[] entries for this symbol across all agents.
 *                        Each agent should contribute at most one signal per symbol.
 */
export function scoreSymbol(symbolSignals: Signal[]): ScoringResult {
  const votes: AgentVote[] = [];
  let weightedScore   = 0;
  let a1Signal: Signal["type"] | null = null;
  let a3Signal: Signal["type"] | null = null;
  let a4VetoActive    = false;
  let a5Present       = false;
  let a5Signal: Signal["type"] | null = null;

  for (const signal of symbolSignals) {
    const { agent, type, confidence, tags = [] } = signal;

    // ── A5 Mean Reversion — track separately, don't score ─────────────────
    if (agent === "Mean Reversion") {
      a5Present = true;
      a5Signal  = type;
      continue;
    }

    // ── A4 veto check ──────────────────────────────────────────────────────
    if (isA4Veto(signal)) {
      a4VetoActive = true;
    }

    // ── Scoring ────────────────────────────────────────────────────────────
    const weight    = AGENT_WEIGHTS[agent] ?? 1;
    const confMult  = CONFIDENCE_MULTIPLIER[confidence] ?? 0.4;
    const direction = VOTE_DIRECTION[type] ?? 0;
    const score     = weight * confMult * direction;

    votes.push({ agentName: agent, signal: type, confidence, weight, score, tags });
    weightedScore += score;

    // Track gate signals
    if (agent === "Momentum Scout")    a1Signal = type;
    if (agent === "Trend Follower")    a3Signal = type;
  }

  // ── Gate check: A1 + A3 must both be present ────────────────────────────
  const gateMet = a1Signal !== null && a3Signal !== null;

  // ── Hard conflict: A1 buy + A3 sell (or vice versa) ─────────────────────
  const hasHardConflict =
    (a1Signal === "buy"  && a3Signal === "sell") ||
    (a1Signal === "sell" && a3Signal === "buy");

  // ── Compute raw verdict ──────────────────────────────────────────────────
  let verdict: ConfluenceVerdict;

  if (!gateMet || hasHardConflict) {
    verdict = "no_trade";
  } else if (weightedScore >= 3.0 && !a4VetoActive) {
    verdict = "aligned_bullish";
  } else if (weightedScore >= 1.5) {
    verdict = "bullish_but_extended"; // score positive but A4 veto or below strong threshold
  } else if (weightedScore <= -3.0) {
    verdict = "bearish_structure";
  } else {
    verdict = "mixed_structure";
  }

  // ── A5 modifier ──────────────────────────────────────────────────────────
  // Applied after base verdict is set.
  if (a5Present && a5Signal === "buy") {
    if (verdict === "mixed_structure") {
      // Oversold bounce firing into a mixed read = countertrend only, no trend support
      verdict = "countertrend_only";
    }
    // aligned_bullish: A5 adds confirmation but doesn't change verdict (tag added in engine)
    // bullish_but_extended: no change — bounce into extension is still risky
  }

  return {
    verdict,
    weightedScore: parseFloat(weightedScore.toFixed(3)),
    votes,
    gateMet,
    hasHardConflict,
    a4VetoActive,
    a5Present,
    a5Signal,
  };
}
