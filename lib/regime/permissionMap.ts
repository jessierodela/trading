/**
 * lib/regime/permissionMap.ts
 *
 * Single source of truth for regime → trade-permission mapping.
 *
 * Consumed by:
 *   - app/api/regime/[symbol]/route.ts  (Markov bot read path)
 *   - app/api/regime/refresh/route.ts   (Markov bot on-demand refresh)
 *
 * Before this module existed, the two routes had divergent tables — every
 * regime row differed. That meant the Markov bot could receive different
 * tradePermission / edgeMultiplier / sizeMultiplier for the same regime
 * depending on which endpoint it hit last. This file fixes that.
 *
 * ─── Numbers chosen ───────────────────────────────────────────────────────
 * The canonical numbers below were taken from the previous version of
 * app/api/regime/refresh/route.ts, which is the endpoint the Markov bot
 * calls on every 5-minute candle close. Those numbers reflect what the bot
 * has been receiving in production. The [symbol] route's table was the
 * dashboard read path and had different numbers, but it was not the live
 * execution path.
 *
 * The MIN_RELIABILITY floor (0.50) was preserved from [symbol]'s table —
 * refresh did not have a reliability floor, and that was a real bug: low-
 * reliability regimes were able to drive sizing decisions. The floor is
 * now enforced for both routes.
 *
 * If you want to use the more conservative [symbol]/route.ts numbers
 * instead, edit the REGIME_GATE table below — there is no second place
 * to change.
 *
 * ─── Previous divergence (for the record) ─────────────────────────────────
 *   regime       [symbol]/route.ts (was)          refresh/route.ts (was)         | canonical here
 *   TREND_UP     ALLOW_UP_ONLY, edge 1.0, sz 1.0  ALLOW_UP_ONLY, edge 0.9, sz 1.25 | refresh
 *   TREND_DOWN   ALLOW_DOWN_ONLY, 1.0, 1.0        ALLOW_DOWN_ONLY, 0.9, 1.25       | refresh
 *   LOW_VOL      ALLOW_BOTH_SMALL, 1.2, 0.5       ALLOW_BOTH, 1.0, 0.75            | refresh
 *   HIGH_VOL     ALLOW_BOTH_SMALL, 1.5, 0.35      ALLOW_BOTH, 1.2, 0.75            | refresh
 *   CHOP         BLOCK_OR_EXCEPTIONAL_ONLY, 2.0, 0.25  BLOCK_OR_EXCEPTIONAL_ONLY, 2.0, 0.5 | refresh
 *   NEWS_SHOCK   BLOCK, 999, 0                    BLOCK, 1.0, 0.0                  | refresh
 *   reliability floor          0.50                          (none)                | preserved from [symbol]
 *
 * Must stay aligned with gate logic in services/regime_oracle.py.
 */

// ─── Public types ─────────────────────────────────────────────────────────

export type RegimeLabel =
  | "TREND_UP"
  | "TREND_DOWN"
  | "LOW_VOL"
  | "HIGH_VOL"
  | "CHOP"
  | "NEWS_SHOCK";

export type TradePermission =
  | "ALLOW_UP_ONLY"
  | "ALLOW_DOWN_ONLY"
  | "ALLOW_BOTH"
  | "ALLOW_BOTH_SMALL"
  | "BLOCK_OR_EXCEPTIONAL_ONLY"
  | "BLOCK";

export type DirectionalBias = "UP" | "DOWN" | "NEUTRAL";

export interface RegimeMappingResult {
  directionalBias: DirectionalBias;
  tradePermission: TradePermission;
  edgeMultiplier:  number;
  sizeMultiplier:  number;
  reason:          string;
}

// ─── Constants ────────────────────────────────────────────────────────────

/** Minimum reliability required to allow any trade. Below this, always BLOCK. */
export const MIN_RELIABILITY = 0.50;

// ─── Canonical table ──────────────────────────────────────────────────────

interface GateConfig {
  directionalBias: DirectionalBias;
  tradePermission: TradePermission;
  edgeMultiplier:  number;
  sizeMultiplier:  number;
}

const REGIME_GATE: Record<RegimeLabel, GateConfig> = {
  TREND_UP: {
    directionalBias: "UP",
    tradePermission: "ALLOW_UP_ONLY",
    edgeMultiplier:  0.9,
    sizeMultiplier:  1.25,
  },
  TREND_DOWN: {
    directionalBias: "DOWN",
    tradePermission: "ALLOW_DOWN_ONLY",
    edgeMultiplier:  0.9,
    sizeMultiplier:  1.25,
  },
  LOW_VOL: {
    directionalBias: "NEUTRAL",
    tradePermission: "ALLOW_BOTH",
    edgeMultiplier:  1.0,
    sizeMultiplier:  0.75,
  },
  HIGH_VOL: {
    directionalBias: "NEUTRAL",
    tradePermission: "ALLOW_BOTH",
    edgeMultiplier:  1.2,
    sizeMultiplier:  0.75,
  },
  CHOP: {
    directionalBias: "NEUTRAL",
    tradePermission: "BLOCK_OR_EXCEPTIONAL_ONLY",
    edgeMultiplier:  2.0,
    sizeMultiplier:  0.5,
  },
  NEWS_SHOCK: {
    directionalBias: "NEUTRAL",
    tradePermission: "BLOCK",
    edgeMultiplier:  1.0,
    sizeMultiplier:  0.0,
  },
};

const REGIME_REASONS: Record<RegimeLabel, string> = {
  TREND_UP:   "Bullish trend regime — EMA stack aligned, momentum intact. UP-side Markov signals supported.",
  TREND_DOWN: "Bearish trend regime — EMA stack falling, momentum negative. DOWN-side Markov signals supported.",
  LOW_VOL:    "Compressed volatility — ATR below baseline. Smaller trades allowed; edge threshold unchanged.",
  HIGH_VOL:   "Elevated volatility — ATR expanding. Higher edge required; size reduced to manage risk.",
  CHOP:       "Choppy regime — no structural bias, Markov transitions unreliable. Only exceptional edges allowed.",
  NEWS_SHOCK: "News shock regime — extreme ATR or volume spike. Markov transition probabilities unstable. Trading blocked.",
};

// ─── Public mapping function ──────────────────────────────────────────────

/**
 * Map a regime label + reliability score to trade-permission output.
 *
 * Hard reliability floor: if reliability < MIN_RELIABILITY, returns BLOCK
 * regardless of regime. This protects against low-confidence regime calls
 * driving real sizing decisions.
 */
export function mapRegimeToPermission(
  regime:      RegimeLabel,
  reliability: number,
): RegimeMappingResult {
  if (reliability < MIN_RELIABILITY) {
    return {
      directionalBias: "NEUTRAL",
      tradePermission: "BLOCK",
      edgeMultiplier:  999,
      sizeMultiplier:  0,
      reason:
        `Regime reliability ${reliability.toFixed(2)} below minimum threshold ` +
        `(${MIN_RELIABILITY}). Trading blocked regardless of regime.`,
    };
  }

  const gate = REGIME_GATE[regime] ?? REGIME_GATE.NEWS_SHOCK;
  return {
    ...gate,
    reason: REGIME_REASONS[regime] ?? "Unknown regime — defaulting to BLOCK.",
  };
}
