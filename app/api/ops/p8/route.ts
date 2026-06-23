import { NextResponse } from "next/server";
import { loadP8OpsSummary } from "@/lib/ops/p8Summary";
import { memCache } from "@/lib/signalsCache";
import { getPgPool } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  try {
    const summary = await loadP8OpsSummary({
      pool: getPgPool(),
      env: process.env,
      memoryResponse: memCache.response,
      memoryExpiresAt: memCache.expiresAt,
    });

    return NextResponse.json(summary, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(
      "[api/ops/p8] read failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      {
        error: "P8 operations data is temporarily unavailable",
        generatedAt: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
