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
import {
  mapRegimeToPermission,
  type RegimeLabel,
} from "@/lib/regime/permissionMap";

// Force dynamic rendering — prevents Next.js from statically pre-rendering
// this route at build time, which would collapse [symbol] into a fixed segment
// and make context.params undefined at runtime.
export const dynamic = "force-dynamic";

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
