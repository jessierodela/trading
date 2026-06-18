import type {
  DashboardSnapshotFilter,
  DashboardSnapshotRecord,
} from "./dashboardSnapshotStore";

export interface EmptyDashboardSignals {
  agentResults: [];
  stats: null;
  activity: [];
  generatedAt: null;
}

export type DashboardSignalsSource = "dashboard_snapshots" | "memCache" | "empty";

export interface DashboardSignalsReadResult {
  source: DashboardSignalsSource;
  payload: unknown;
  snapshot?: DashboardSnapshotRecord;
  error?: string;
}

export interface DashboardSnapshotReader {
  fetchLatestSnapshot(filter: DashboardSnapshotFilter): Promise<DashboardSnapshotRecord | null>;
}

export function emptyDashboardSignals(): EmptyDashboardSignals {
  return {
    agentResults: [],
    stats: null,
    activity: [],
    generatedAt: null,
  };
}

export async function readDashboardSignals(input: {
  snapshotStore?: DashboardSnapshotReader | null;
  memoryResponse?: object | null;
  memoryExpiresAt?: number;
  nowMs?: number;
  onSnapshotError?: (error: unknown) => void;
}): Promise<DashboardSignalsReadResult> {
  if (input.snapshotStore) {
    try {
      const snapshot = await input.snapshotStore.fetchLatestSnapshot({
        snapshotType: "dashboard",
        includeExpired: false,
      });
      if (snapshot) {
        return {
          source: "dashboard_snapshots",
          payload: snapshot.payload,
          snapshot,
        };
      }
    } catch (err) {
      input.onSnapshotError?.(err);
    }
  }

  const nowMs = input.nowMs ?? Date.now();
  if (input.memoryResponse && input.memoryExpiresAt !== undefined && nowMs < input.memoryExpiresAt) {
    return {
      source: "memCache",
      payload: input.memoryResponse,
    };
  }

  return {
    source: "empty",
    payload: emptyDashboardSignals(),
  };
}
