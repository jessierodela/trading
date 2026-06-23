import type { JobPayload } from "@/lib/jobs/types";
import { runDashboardRefreshPipeline, writeDashboardSnapshot } from "@/lib/pipeline";
import {
  handlerNotImplemented,
  handlerSuccess,
  requireService,
  retryableFailure,
  type JobHandler,
} from "./types";

type DashboardPayload = Extract<JobPayload, { jobType: "dashboard.snapshot" }>;

export const handleDashboardSnapshot: JobHandler<DashboardPayload> = async (payload, context) => {
  if (payload.snapshotType !== "dashboard") {
    return handlerNotImplemented(
      payload.jobType,
      `dashboard.snapshot snapshotType=${payload.snapshotType} needs a source-specific snapshot assembler`,
    );
  }

  const dashboardSnapshotStore = requireService(context.services, "dashboardSnapshotStore", undefined);
  const runDashboard = context.services.runDashboardRefreshPipeline ?? runDashboardRefreshPipeline;
  const writeSnapshot = context.services.writeDashboardSnapshot ?? writeDashboardSnapshot;

  try {
    const refreshed = await runDashboard();
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
    });
  } catch (err) {
    return retryableFailure("dashboard_snapshot_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
