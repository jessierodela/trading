import type { JobHandler } from "./types";
import type { JobType } from "@/lib/jobs/types";
import { JOB_TYPES } from "@/lib/jobs/types";
import { handleDashboardSnapshot } from "./dashboardSnapshot";
import { handleFeaturesCompute } from "./featuresCompute";
import { handleMarketIngestLatest } from "./marketIngestLatest";
import { handlePaperMonitor } from "./paperMonitor";
import { handleRegimeCompute } from "./regimeCompute";
import { handleStrategiesEvaluate } from "./strategiesEvaluate";
import { handleTelegramRefresh } from "./telegramRefresh";

export const JOB_HANDLER_REGISTRY: Record<JobType, JobHandler> = {
  "market.ingest.latest": handleMarketIngestLatest as JobHandler,
  "features.compute": handleFeaturesCompute as JobHandler,
  "regime.compute": handleRegimeCompute as JobHandler,
  "strategies.evaluate": handleStrategiesEvaluate as JobHandler,
  "paper.monitor": handlePaperMonitor as JobHandler,
  "dashboard.snapshot": handleDashboardSnapshot as JobHandler,
  "telegram.refresh": handleTelegramRefresh as JobHandler,
};

export function getJobHandler(jobType: JobType): JobHandler {
  return JOB_HANDLER_REGISTRY[jobType];
}

export function assertJobHandlerRegistryComplete(): void {
  const missing = JOB_TYPES.filter((jobType) => !JOB_HANDLER_REGISTRY[jobType]);
  if (missing.length > 0) {
    throw new Error(`missing job handlers: ${missing.join(", ")}`);
  }
}

export * from "./types";
