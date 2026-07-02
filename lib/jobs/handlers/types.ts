import type { Pool } from "pg";
import type { RegimeSignal } from "@/lib/agents/regimeDetector";
import type { DashboardSnapshotStore } from "@/lib/jobs/dashboardSnapshotStore";
import type { JobRecord, JobStore } from "@/lib/jobs/jobStore";
import type { JobPayload } from "@/lib/jobs/types";
import type { PaperTradingStore } from "@/lib/execution";
import type {
  DashboardRefreshPipelineInput,
  DashboardRefreshPipelineResult,
  DashboardSnapshotWriteInput,
  DashboardSnapshotWriteResult,
  MarketIngestLatestPipelineInput,
  MarketIngestLatestPipelineResult,
  RegimeRefreshPipelineInput,
  RegimeRefreshPipelineResult,
} from "@/lib/pipeline/types";
import type { CacheSnapshot } from "@/lib/indicatorCache";
import type { CacheSnapshot1d } from "@/lib/indicatorCache1d";
import type { FeatureStore, RegimeStore, SignalStore, BarStore } from "@/lib/storage";
import type { TradeIntentStore } from "@/lib/tradeIntent";
import type { RiskDecisionStore } from "@/lib/risk/riskDecisionStore";

export interface JobHandlerServices {
  pool?: Pool;
  barStore?: BarStore;
  featureStore?: FeatureStore;
  regimeStore?: RegimeStore;
  signalStore?: SignalStore;
  paperStore?: PaperTradingStore;
  intentStore?: TradeIntentStore;
  riskDecisionStore?: RiskDecisionStore;
  dashboardSnapshotStore?: DashboardSnapshotStore;
  runDashboardRefreshPipeline?: (
    input?: DashboardRefreshPipelineInput,
  ) => Promise<DashboardRefreshPipelineResult>;
  runMarketIngestLatestPipeline?: (
    input: MarketIngestLatestPipelineInput,
  ) => Promise<MarketIngestLatestPipelineResult>;
  runRegimeRefreshPipeline?: (
    input?: RegimeRefreshPipelineInput,
  ) => Promise<RegimeRefreshPipelineResult>;
  runRegimeDetector?: (
    snapshot: CacheSnapshot,
    snapshot1d: CacheSnapshot1d,
    symbols?: string[],
  ) => Promise<RegimeSignal[]>;
  writeDashboardSnapshot?: (
    input: DashboardSnapshotWriteInput,
  ) => Promise<DashboardSnapshotWriteResult>;
}

export interface JobHandlerContext {
  workerId: string;
  job: JobRecord;
  store: JobStore;
  now: () => Date;
  services: JobHandlerServices;
  signal?: AbortSignal;
}

export interface JobHandlerSuccess {
  success: true;
  result: unknown;
}

export interface JobHandlerFailure {
  success: false;
  retryable: boolean;
  error: string;
  result?: unknown;
}

export type JobHandlerResult = JobHandlerSuccess | JobHandlerFailure;

export type JobHandler<TPayload extends JobPayload = JobPayload> = (
  payload: TPayload,
  context: JobHandlerContext,
) => Promise<JobHandlerResult>;

export function handlerSuccess(result: unknown): JobHandlerSuccess {
  return { success: true, result };
}

export function handlerFailure(
  error: string,
  retryable: boolean,
  result?: unknown,
): JobHandlerFailure {
  return {
    success: false,
    retryable,
    error,
    ...(result === undefined ? {} : { result }),
  };
}

export function handlerNotImplemented(jobType: string, reason: string): JobHandlerFailure {
  return handlerFailure("handler_not_implemented", false, { jobType, reason });
}

export function invalidPayload(reason: string, details?: unknown): JobHandlerFailure {
  return handlerFailure("invalid_payload", false, { reason, details });
}

export function retryableFailure(error: string, details?: unknown): JobHandlerFailure {
  return handlerFailure(error, true, details);
}

export function requireService<K extends keyof JobHandlerServices>(
  services: JobHandlerServices,
  key: K,
  fallback?: NonNullable<JobHandlerServices[K]>,
): NonNullable<JobHandlerServices[K]> {
  const service = services[key] ?? fallback;
  if (!service) {
    throw new Error(`handler service unavailable: ${String(key)}`);
  }
  return service as NonNullable<JobHandlerServices[K]>;
}
