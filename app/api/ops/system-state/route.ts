/**
 * app/api/ops/system-state/route.ts
 *
 * Read-only composition of the P8 ops summary and the P11 risk gate summary
 * into a single dashboard-facing system state (flow map, attention list,
 * data truthfulness). Unlike /api/ops/p8 this route never returns 503:
 * unavailability is part of the state it reports, so the dashboard can render
 * "unknown, and here is why" instead of hiding behind an error page.
 */
import { NextResponse } from "next/server";
import { buildSystemState, loadSystemState } from "@/lib/ops/systemState";
import { memCache } from "@/lib/signalsCache";
import { getPgPool } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };

  let state;
  try {
    state = await loadSystemState({
      pool: getPgPool(),
      env: process.env,
      memoryResponse: memCache.response,
      memoryExpiresAt: memCache.expiresAt,
    });
  } catch (error) {
    // Pool creation failed (e.g. SUPABASE_DB_URL missing). Report it as
    // state rather than failing the request.
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[api/ops/system-state] database unavailable:", reason);
    state = buildSystemState({
      ops: null,
      opsReason: `database unavailable: ${reason}`,
      riskGate: null,
      riskGateReason: `database unavailable: ${reason}`,
    });
  }

  return NextResponse.json(state, { headers });
}
