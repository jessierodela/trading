/**
 * app/api/regime/[symbol]/route.ts
 *
 * GET /api/regime/[symbol]
 *
 * Regime Oracle endpoint consumed by the Markov bot.
 * Reads from memCache.response.regimeMap after a queued dashboard refresh
 * completes. No GPT calls, no indicator fetches, pure cache read.
 *
 * Response contract:
 *   symbol           string
 *   regime           string
 *   reliability      number
 *   directionalBias  string
 *   tradePermission  string
 *   edgeMultiplier   number
 *   sizeMultiplier   number
 *   emaContext       object
 *   volContext       object
 *   reason           string
 *   updatedAt        ISO8601
 */

import { NextResponse } from "next/server";
import { memCache } from "@/lib/signalsCache";
import {
  mapRegimeToPermission,
  type RegimeLabel,
} from "@/lib/regime/permissionMap";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await params;
  const upper = symbol.toUpperCase();

  try {
    const payload = memCache.response as {
      regimeMap?: Record<string, {
        regime: RegimeLabel;
        reliability: number;
        emaContext: { ema20Slope: string; ema50Above200: boolean | null };
        volContext: { atrPct: number | null; atrRegime: string; relVol: number | null };
      }>;
      generatedAt?: string;
    } | null;

    if (!payload?.regimeMap) {
      return NextResponse.json(
        {
          success: false,
          error: "Regime cache is empty. Queue a dashboard refresh and wait for completion first.",
          symbol: upper,
        },
        { status: 404 },
      );
    }

    const ctx = payload.regimeMap[upper];
    if (!ctx) {
      return NextResponse.json(
        {
          success: false,
          error: `No regime data for symbol ${upper}. Supported symbols are: ${Object.keys(payload.regimeMap).join(", ")}.`,
          symbol: upper,
        },
        { status: 404 },
      );
    }

    const mapped = mapRegimeToPermission(ctx.regime, ctx.reliability);

    return NextResponse.json({
      success: true,
      symbol: upper,
      regime: ctx.regime,
      reliability: ctx.reliability,
      directionalBias: mapped.directionalBias,
      tradePermission: mapped.tradePermission,
      edgeMultiplier: mapped.edgeMultiplier,
      sizeMultiplier: mapped.sizeMultiplier,
      emaContext: ctx.emaContext,
      volContext: ctx.volContext,
      reason: mapped.reason,
      updatedAt: payload.generatedAt ?? null,
    });
  } catch (e) {
    console.error("[api/regime] Unhandled error:", e);
    return NextResponse.json(
      { success: false, error: "Internal server error", detail: String(e) },
      { status: 500 },
    );
  }
}
