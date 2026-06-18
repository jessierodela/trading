/**
 * app/api/signals/route.ts
 *
 * Read-only dashboard state endpoint.
 *
 * P8D preference order:
 *   1. Latest non-expired dashboard_snapshots row with snapshotType=dashboard
 *   2. Transitional in-memory cache
 *   3. Empty dashboard state
 */

import { NextResponse } from "next/server";
import { DashboardSnapshotStore } from "@/lib/jobs/dashboardSnapshotStore";
import { readDashboardSignals } from "@/lib/jobs/dashboardSignalsReader";
import { getPgPool } from "@/lib/storage";
import { memCache } from "@/lib/signalsCache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TAG = "[api/signals]";

export async function GET() {
  const reqId = Math.random().toString(36).slice(2, 7);
  console.log(`${TAG} [${reqId}] GET /api/signals`);

  let snapshotStore: DashboardSnapshotStore | null = null;
  try {
    snapshotStore = new DashboardSnapshotStore(getPgPool());
  } catch (err) {
    console.warn(
      `${TAG} [${reqId}] snapshot store unavailable - falling back: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const result = await readDashboardSignals({
    snapshotStore,
    memoryResponse: memCache.response,
    memoryExpiresAt: memCache.expiresAt,
    onSnapshotError: (err) => {
      console.warn(
        `${TAG} [${reqId}] snapshot read failed - falling back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    },
  });

  if (result.source === "dashboard_snapshots") {
    console.log(
      `${TAG} [${reqId}] HIT dashboard_snapshots generatedAt=${result.snapshot?.generatedAt ?? "unknown"}`,
    );
  } else if (result.source === "memCache") {
    const ttlLeft = ((memCache.expiresAt - Date.now()) / 1000).toFixed(1);
    const cached = memCache.response as { generatedAt?: string } | null;
    console.log(
      `${TAG} [${reqId}] HIT memCache expires in ${ttlLeft}s, generatedAt=${cached?.generatedAt ?? "unknown"}`,
    );
  } else {
    console.log(`${TAG} [${reqId}] MISS returning empty state`);
  }

  return NextResponse.json(result.payload);
}
