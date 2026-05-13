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

export type RegimeLabel =
  | "TREND_UP"
  | "TREND_DOWN"
  | "LOW_VOL"
  | "HIGH_VOL"
  | "CHOP"
  | "NEWS_SHOCK";

/**
 * Regime context passed into scoreSymbol. Sourced from A6 Regime Detector output.
 * Optional fields are kept loose so the engine doesn't have to construct full
 * RegimeSignal objects — only regime + reliability are required for gating.
 */
export interface RegimeContext {
  regime:      RegimeLabel;
  reliability: number;          // 0–1 from A6
}

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
  // ── Regime gating (A6 context) ──────────────────────────────────────────
  regime:              RegimeLabel | null;  // null = no regime context provided
  regimeReliability:   number | null;
  regimeBlocked:       boolean;             // hard block (forces no_trade)
  regimeBlockReason:   string | null;
  regimeDirectionalConflict: boolean;       // softer: score sign conflicts with regime trend
  thresholdMultiplier: number;              // applied to aligned/bearish score thresholds
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

// ─── Regime gating constants ────────────────────────────────────────────────
// Single source of truth for regime → confluence gating behavior.
// Must stay aligned with lib/regime/permissionMap.ts (the bot-facing mapping).

const MIN_RELIABILITY = 0.50;

// CHOP raises the score threshold for aligned verdicts by this multiplier.
// Default aligned thresholds are ±3.0; in CHOP that becomes ±(3.0 * 1.5) = ±4.5.
const CHOP_THRESHOLD_MULTIPLIER = 1.5;

// Hard-block regimes — verdict is forced to no_trade regardless of votes.
const BLOCKING_REGIMES = new Set<RegimeLabel>(["NEWS_SHOCK"]);

// ─── Scorer ────────────────────────────────────────────────────────────────

/**
 * Score all agent signals for a single symbol.
 *
 * @param symbolSignals - All Signal[] entries for this symbol across A1–A5.
 *                        A6 Regime Detector signals are ignored if present
 *                        (defensive — engine should filter them out upstream).
 * @param regimeCtx      - Optional regime context from A6. When provided,
 *                         regime gating is applied to the verdict:
 *                           - reliability < 0.50      → forced no_trade
 *                           - NEWS_SHOCK              → forced no_trade
 *                           - CHOP                    → aligned thresholds raised 1.5x
 *                           - TREND_UP vs bearish score → directional conflict, verdict softened
 *                           - TREND_DOWN vs bullish score → directional conflict, verdict softened
 *                         When omitted, no regime gating is applied (legacy behavior).
 */
export function scoreSymbol(
  symbolSignals: Signal[],
  regimeCtx?:    RegimeContext,
): ScoringResult {
  const votes: AgentVote[] = [];
  let weightedScore   = 0;
  let a1Signal: Signal["type"] | null = null;
  let a3Signal: Signal["type"] | null = null;
  let a4VetoActive    = false;
  let a5Present       = false;
  let a5Signal: Signal["type"] | null = null;

  for (const signal of symbolSignals) {
    const { agent, type, confidence, tags = [] } = signal;

    // ── A6 Regime Detector — never scored, never vote ─────────────────────
    // Regime is consumed via regimeCtx parameter, not via signal votes.
    // This guard prevents accidental scoring if A6 leaks through filtering.
    if (agent === "Regime Detector") continue;

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

  // ── Regime evaluation ────────────────────────────────────────────────────
  // Done before verdict so regime can short-circuit to no_trade,
  // adjust score thresholds, or soften directional verdicts.
  let regime: RegimeLabel | null = null;
  let regimeReliability: number | null = null;
  let regimeBlocked = false;
  let regimeBlockReason: string | null = null;
  let regimeDirectionalConflict = false;
  let thresholdMultiplier = 1.0;

  if (regimeCtx) {
    regime            = regimeCtx.regime;
    regimeReliability = regimeCtx.reliability;

    if (regimeCtx.reliability < MIN_RELIABILITY) {
      regimeBlocked     = true;
      regimeBlockReason =
        `Regime reliability ${regimeCtx.reliability.toFixed(2)} below ${MIN_RELIABILITY} threshold`;
    } else if (BLOCKING_REGIMES.has(regimeCtx.regime)) {
      regimeBlocked     = true;
      regimeBlockReason = `Regime ${regimeCtx.regime} blocks trading`;
    } else if (regimeCtx.regime === "CHOP") {
      // Raise the bar for aligned verdicts but don't block outright.
      thresholdMultiplier = CHOP_THRESHOLD_MULTIPLIER;
    }

    // Directional conflict: score direction disagrees with trend regime.
    // This is a soft signal — it suppresses aligned/bearish verdicts but
    // does not force no_trade. Captured as a tag for downstream consumers.
    if (regimeCtx.regime === "TREND_UP"   && weightedScore <= -1.5) regimeDirectionalConflict = true;
    if (regimeCtx.regime === "TREND_DOWN" && weightedScore >= 1.5)  regimeDirectionalConflict = true;
  }

  // ── Compute raw verdict ──────────────────────────────────────────────────
  const alignedBullishThreshold = 3.0 * thresholdMultiplier;
  const bullishLeanThreshold    = 1.5 * thresholdMultiplier;
  const bearishThreshold        = -3.0 * thresholdMultiplier;

  let verdict: ConfluenceVerdict;

  if (regimeBlocked) {
    verdict = "no_trade";
  } else if (!gateMet || hasHardConflict) {
    verdict = "no_trade";
  } else if (weightedScore >= alignedBullishThreshold && !a4VetoActive && !regimeDirectionalConflict) {
    verdict = "aligned_bullish";
  } else if (weightedScore >= bullishLeanThreshold) {
    // bullish_but_extended captures: A4 veto, sub-aligned scores, or directional conflict with TREND_DOWN
    verdict = "bullish_but_extended";
  } else if (weightedScore <= bearishThreshold && !regimeDirectionalConflict) {
    verdict = "bearish_structure";
  } else {
    verdict = "mixed_structure";
  }

  // ── A5 modifier ──────────────────────────────────────────────────────────
  // Applied after base verdict is set, but only if not regime-blocked.
  if (!regimeBlocked && a5Present && a5Signal === "buy") {
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
    regime,
    regimeReliability,
    regimeBlocked,
    regimeBlockReason,
    regimeDirectionalConflict,
    thresholdMultiplier,
  };
}
