import { NextResponse } from "next/server";
import { loadRiskGateSummary } from "@/lib/ops/riskGateSummary";
import { getPgPool } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  try {
    const summary = await loadRiskGateSummary({ pool: getPgPool() });

    return NextResponse.json(summary, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(
      "[api/ops/risk-gate] read failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      {
        error: "Risk gate operations data is temporarily unavailable",
        generatedAt: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
