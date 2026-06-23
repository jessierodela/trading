import type { DashboardSnapshotWriteInput, DashboardSnapshotWriteResult } from "@/lib/pipeline/types";

export async function writeDashboardSnapshot(
  input: DashboardSnapshotWriteInput,
): Promise<DashboardSnapshotWriteResult> {
  if (!input.store) {
    return {
      success: true,
      skipped: true,
      reason: "dashboard snapshot store not provided",
    };
  }

  const snapshot = await input.store.insertSnapshot({
    snapshotType: input.snapshotType,
    symbol: input.symbol ?? null,
    timeframe: input.timeframe ?? null,
    payload: input.payload,
    sourceJobId: input.sourceJobId ?? null,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
  });

  return {
    success: true,
    skipped: false,
    snapshot,
  };
}
