/**
 * app/api/regime/[symbol]/route.ts
 *
 * GET /api/regime/[symbol]
 *
 * Regime Oracle endpoint consumed by the Markov bot.
 *
 * P8D read priority:
 *   1. latest regime_snapshots row for the symbol/exchange
 *   2. latest non-expired dashboard_snapshots payload.regimeMap
 *   3. transitional process-local memCache.response.regimeMap
 *   4. 404 empty state
 *
 * This route does not run GPT, indicator fetches, refresh pipelines, worker
 * handlers, or route-to-route refresh calls.
 */

import { NextResponse } from "next/server";
import { DashboardSnapshotStore } from "@/lib/jobs/dashboardSnapshotStore";
import { readRegimeRouteState } from "@/lib/regime/regimeRouteReader";
import { memCache } from "@/lib/signalsCache";
import { getPgPool, PgRegimeStore } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await params;

  let regimeStore: PgRegimeStore | null = null;
  let dashboardSnapshotStore: DashboardSnapshotStore | null = null;
  try {
    const pool = getPgPool();
    regimeStore = new PgRegimeStore(pool);
    dashboardSnapshotStore = new DashboardSnapshotStore(pool);
  } catch (err) {
    console.warn(
      `[api/regime] persisted stores unavailable - falling back: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const result = await readRegimeRouteState({
    symbol,
    regimeStore,
    dashboardSnapshotStore,
    memoryResponse: memCache.response,
    onPersistedReadError: (err) => {
      console.warn(
        `[api/regime] persisted regime read failed - falling back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    },
  });

  return NextResponse.json(result.body, { status: result.status });
}
