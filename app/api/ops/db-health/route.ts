import { NextResponse } from "next/server";
import { loadDbHealth } from "@/lib/ops/dbHealth";
import { getPgPool } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };

  try {
    const summary = await loadDbHealth({ pool: getPgPool(), env: process.env });
    return NextResponse.json(summary, { status: summary.ok ? 200 : 503, headers });
  } catch (error) {
    // getPgPool() itself throws when SUPABASE_DB_URL/DATABASE_URL is unset —
    // report as unhealthy rather than an unhandled 500, without leaking the
    // env var state itself into the response body.
    console.error(
      "[api/ops/db-health] pool unavailable:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        ok: false,
        latencyMs: null,
        dbTime: null,
        poolConfig: null,
        error: "database connection is not configured",
      },
      { status: 503, headers },
    );
  }
}
