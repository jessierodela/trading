/**
 * app/api/regime/[symbol]/route.ts
 *
 * GET /api/regime/[symbol]
 *
 * Regime Oracle endpoint — consumed by the Markov bot.
 *
 * Reads from memCache.response.regimeMap (written by POST /api/cache/refresh).
 * No GPT calls, no indicator fetches — pure cache read.
 *
 * Response contract (immutable — Markov bot depends on these field names):
 *   symbol           string    — uppercased asset symbol
 *   regime           string    — A6 label: TREND_UP | TREND_DOWN | LOW_VOL | HIGH_VOL | CHOP | NEWS_SHOCK
 *   reliability      number    — 0.0–1.0 confidence from A6
 *   directionalBias  string    — UP | DOWN | NEUTRAL
 *   tradePermission  string    — ALLOW_UP_ONLY | ALLOW_DOWN_ONLY | ALLOW_BOTH | ALLOW_BOTH_SMALL | BLOCK_OR_EXCEPTIONAL_ONLY | BLOCK
 *   edgeMultiplier   number    — multiplier applied to Markov epsilon threshold
 *   sizeMultiplier   number    — multiplier applied to base position size
 *   emaContext       object    — { ema20Slope, ema50Above200 }
 *   volContext       object    — { atrPct, atrRegime, relVol }
 *   reason           string    — human-readable gate rationale
 *   updatedAt        ISO8601   — Markov bot uses this for freshness check
 *
 * Failure behavior:
 *   404 — no regime data for symbol (cache not yet populated)
 *   200 with BLOCK — reliability below minimum threshold
 *
 * Do NOT add auth here until the Markov bot is ready to send a token.
 * The endpoint is read-only and returns no trading secrets.
 */

import { NextResponse } from "next/server";
import { memCache }     from "@/lib/signalsCache";

// Force dynamic rendering — prevents Next.js from statically pre-rendering
// this route at build time, which would collapse [symbol] into a fixed segment
// and make context.params undefined at runtime.
export const dynamic = "force-dynamic";

// ─── Regime types ─────────────────────────────────────────────────────────────

type RegimeLabel =
  | "TREND_UP"
  | "TREND_DOWN"
  | "LOW_VOL"
  | "HIGH_VOL"
  | "CHOP"
  | "NEWS_SHOCK";

type TradePermission =
  | "ALLOW_UP_ONLY"
  | "ALLOW_DOWN_ONLY"
  | "ALLOW_BOTH"
  | "ALLOW_BOTH_SMALL"
  | "BLOCK_OR_EXCEPTIONAL_ONLY"
  | "BLOCK";

type DirectionalBias = "UP" | "DOWN" | "NEUTRAL";

interface RegimeMappingResult {
  directionalBias: DirectionalBias;
  tradePermission: TradePermission;
  edgeMultiplier:  number;
  sizeMultiplier:  number;
  reason:          string;
}

// ─── Mapping table ────────────────────────────────────────────────────────────
// Single source of truth for regime → Markov gate parameters.
// Must stay in sync with the integration spec (regime_oracle_markov_bot_integration_flow.md).

const REGIME_MAP: Record<RegimeLabel, Omit<RegimeMappingResult, "reason">> = {
  TREND_UP:   { directionalBias: "UP",      tradePermission: "ALLOW_UP_ONLY",           edgeMultiplier: 1.0, sizeMultiplier: 1.0  },
  TREND_DOWN: { directionalBias: "DOWN",    tradePermission: "ALLOW_DOWN_ONLY",          edgeMultiplier: 1.0, sizeMultiplier: 1.0  },
  LOW_VOL:    { directionalBias: "NEUTRAL", tradePermission: "ALLOW_BOTH_SMALL",         edgeMultiplier: 1.2, sizeMultiplier: 0.5  },
  HIGH_VOL:   { directionalBias: "NEUTRAL", tradePermission: "ALLOW_BOTH_SMALL",         edgeMultiplier: 1.5, sizeMultiplier: 0.35 },
  CHOP:       { directionalBias: "NEUTRAL", tradePermission: "BLOCK_OR_EXCEPTIONAL_ONLY",edgeMultiplier: 2.0, sizeMultiplier: 0.25 },
  NEWS_SHOCK: { directionalBias: "NEUTRAL", tradePermission: "BLOCK",                    edgeMultiplier: 999, sizeMultiplier: 0    },
};

const REGIME_REASONS: Record<RegimeLabel, string> = {
  TREND_UP:   "Bullish trend regime — EMA stack aligned, momentum intact. UP-side Markov signals supported.",
  TREND_DOWN: "Bearish trend regime — EMA stack falling, momentum negative. DOWN-side Markov signals supported.",
  LOW_VOL:    "Compressed volatility — ATR below baseline. Smaller trades allowed; edge threshold raised slightly.",
  HIGH_VOL:   "Elevated volatility — ATR expanding. Higher edge required; size reduced to manage risk.",
  CHOP:       "Choppy regime — no structural bias, Markov transitions unreliable. Only exceptional edges allowed.",
  NEWS_SHOCK: "News shock regime — extreme ATR or volume spike. Markov transition probabilities unstable. Trading blocked.",
};

// Minimum reliability to allow any trade — below this, always BLOCK.
const MIN_RELIABILITY = 0.50;

// ─── Mapping helper ───────────────────────────────────────────────────────────

function mapRegimeToPermission(regime: RegimeLabel, reliability: number): RegimeMappingResult {
  // Hard reliability floor — below threshold, override everything to BLOCK.
  if (reliability < MIN_RELIABILITY) {
    return {
      directionalBias: "NEUTRAL",
      tradePermission: "BLOCK",
      edgeMultiplier:  999,
      sizeMultiplier:  0,
      reason: `Regime reliability ${reliability.toFixed(2)} below minimum threshold (${MIN_RELIABILITY}). Trading blocked regardless of regime.`,
    };
  }

  const mapping = REGIME_MAP[regime] ?? REGIME_MAP["NEWS_SHOCK"];
  return {
    ...mapping,
    reason: REGIME_REASONS[regime] ?? "Unknown regime — defaulting to BLOCK.",
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const { symbol } = await params;
  const upper = symbol.toUpperCase();

  try {

    // Read from in-memory cache — no DB, no GPT, instant.
    const payload = memCache.response as {
      regimeMap?: Record<string, {
        regime:      RegimeLabel;
        reliability: number;
        emaContext:  { ema20Slope: string; ema50Above200: boolean | null };
        volContext:  { atrPct: number | null; atrRegime: string; relVol: number | null };
      }>;
      generatedAt?: string;
    } | null;

    // Cache empty — dashboard hasn't been refreshed yet.
    if (!payload?.regimeMap) {
      return NextResponse.json(
        {
          success:  false,
          error:    "Regime cache is empty. Trigger POST /api/cache/refresh first.",
          symbol:   upper,
        },
        { status: 404 }
      );
    }

    // Symbol not in regime map — not tracked or A6 skipped it.
    const ctx = payload.regimeMap[upper];
    if (!ctx) {
      return NextResponse.json(
        {
          success: false,
          error:   `No regime data for symbol ${upper}. Supported symbols are: ${Object.keys(payload.regimeMap).join(", ")}.`,
          symbol:  upper,
        },
        { status: 404 }
      );
    }

    const mapped = mapRegimeToPermission(ctx.regime, ctx.reliability);

    return NextResponse.json({
      success:         true,
      symbol:          upper,
      regime:          ctx.regime,
      reliability:     ctx.reliability,
      directionalBias: mapped.directionalBias,
      tradePermission: mapped.tradePermission,
      edgeMultiplier:  mapped.edgeMultiplier,
      sizeMultiplier:  mapped.sizeMultiplier,
      emaContext:      ctx.emaContext,
      volContext:      ctx.volContext,
      reason:          mapped.reason,
      updatedAt:       payload.generatedAt ?? null,
    });

  } catch (e) {
    console.error("[api/regime] Unhandled error:", e);
    return NextResponse.json(
      { success: false, error: "Internal server error", detail: String(e) },
      { status: 500 }
    );
  }
}
