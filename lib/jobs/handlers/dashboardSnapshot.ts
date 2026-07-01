import { DEFAULT_SCHEDULED_FEED_EXCHANGE, DEFAULT_SCHEDULED_FEED_SYMBOLS } from "@/lib/jobs/scheduler";
import type { JobPayload } from "@/lib/jobs/types";
import {
  createPersistedFeatureCacheAdapters,
  runDashboardRefreshPipeline,
  writeDashboardSnapshot,
} from "@/lib/pipeline";
import {
  handlerNotImplemented,
  handlerSuccess,
  requireService,
  retryableFailure,
  type JobHandler,
} from "./types";

type DashboardPayload = Extract<JobPayload, { jobType: "dashboard.snapshot" }>;

const LOG_PREFIX = "[dashboard.snapshot]";

export const handleDashboardSnapshot: JobHandler<DashboardPayload> = async (payload, context) => {
  if (payload.snapshotType !== "dashboard") {
    return handlerNotImplemented(
      payload.jobType,
      `dashboard.snapshot snapshotType=${payload.snapshotType} needs a source-specific snapshot assembler`,
    );
  }

  const dashboardSnapshotStore = requireService(context.services, "dashboardSnapshotStore", undefined);
  const featureStore = requireService(context.services, "featureStore", undefined);
  const runDashboard = context.services.runDashboardRefreshPipeline ?? runDashboardRefreshPipeline;
  const writeSnapshot = context.services.writeDashboardSnapshot ?? writeDashboardSnapshot;

  // P10B: dashboard.snapshot reads persisted feature_snapshots only — it never
  // reaches the legacy live-vendor indicator cache or the debug-only manual
  // refresh route. createPersistedFeatureCacheAdapters bridges persisted rows
  // into the same cache-shaped input the deterministic agent/regime logic
  // already consumes, so no external round-trip (and no artificial 1D wait)
  // is needed.
  const symbols = payload.symbols ?? [...DEFAULT_SCHEDULED_FEED_SYMBOLS];
  const { cache, cache1d } = createPersistedFeatureCacheAdapters({
    featureStore,
    symbols,
    exchange: DEFAULT_SCHEDULED_FEED_EXCHANGE,
    now: context.now,
  });

  try {
    const refreshed = await runDashboard({
      cache,
      cache1d,
      waitBefore1dMs: 0,
      dataSource: "persisted_feature_snapshots",
      logPrefix: LOG_PREFIX,
      now: context.now,
      nowMs: () => context.now().getTime(),
    });
    if (!refreshed.ok) {
      return retryableFailure("dashboard_refresh_failed", {
        status: refreshed.status,
        body: refreshed.body,
      });
    }

    const written = await writeSnapshot({
      store: dashboardSnapshotStore,
      snapshotType: "dashboard",
      payload: refreshed.body,
      sourceJobId: context.job.id,
      generatedAt: refreshed.body.generatedAt,
    });
    if (written.skipped) {
      return retryableFailure("dashboard_snapshot_write_skipped", written);
    }

    return handlerSuccess({
      jobType: payload.jobType,
      snapshotType: payload.snapshotType,
      snapshotPublicId: written.snapshot.publicId,
      snapshotId: written.snapshot.id,
      generatedAt: written.snapshot.generatedAt,
      durationMs: refreshed.body.durationMs,
      confluenceCount: refreshed.body.confluence.length,
      agentCount: refreshed.body.agentResults.length,
      dataQuality: refreshed.body.dataQuality,
    });
  } catch (err) {
    return retryableFailure("dashboard_snapshot_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
