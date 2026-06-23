import type { JobRecord, JobStore } from "@/lib/jobs/jobStore";
import type { JobPayload, JobType } from "@/lib/jobs/types";

export const SCHEDULED_FEED_NAME = "non-stop scheduled feed";

export const DEFAULT_SCHEDULED_FEED_SYMBOLS = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "LINK-USD",
  "AVAX-USD",
] as const;

export const DEFAULT_SCHEDULED_FEED_EXCHANGE = "COINBASE";
export const DEFAULT_SCHEDULED_FEED_TIMEFRAME = "1h";
export const DEFAULT_SCHEDULED_FEED_SOURCE = "coinbase";

export type ScheduledFeedExchange = "COINBASE" | "BINANCE" | "POLYGON";
export type ScheduledFeedTimeframe = "1h";
export type ScheduledFeedSource = "coinbase" | "polygon";

export interface ScheduledFeedConfig {
  symbols: string[];
  exchange: ScheduledFeedExchange;
  timeframe: ScheduledFeedTimeframe;
  source: ScheduledFeedSource;
}

export interface ScheduledFeedConfigOverrides {
  symbols?: string[] | string;
  exchange?: string;
  timeframe?: string;
  source?: string;
}

export type ScheduledFeedStageName =
  | "market.ingest.latest"
  | "features.compute"
  | "regime.compute"
  | "strategies.evaluate"
  | "paper.monitor"
  | "dashboard.snapshot";

export interface ScheduledFeedStageDefinition {
  stage: ScheduledFeedStageName;
  jobType: JobType;
  priority: number;
  offsetMinutes: number;
}

export interface ScheduledFeedStagePlan extends ScheduledFeedStageDefinition {
  payload: JobPayload;
  dedupeKey: string;
  runAfter: string;
}

export interface ScheduledFeedPlan {
  feedName: typeof SCHEDULED_FEED_NAME;
  generatedAt: string;
  closedBarTs: string;
  symbols: string[];
  exchange: ScheduledFeedExchange;
  timeframe: ScheduledFeedTimeframe;
  source: ScheduledFeedSource;
  stages: ScheduledFeedStagePlan[];
}

export type ScheduledFeedStore = Pick<JobStore, "enqueueJob" | "listJobs">;

export type ScheduledFeedJobAction =
  | "dry_run"
  | "enqueued"
  | "deduped"
  | "skipped_succeeded";

export interface ScheduledFeedJobSummary {
  stage: ScheduledFeedStageName;
  jobType: JobType;
  jobId: string | null;
  status: JobRecord["status"] | "dry_run";
  action: ScheduledFeedJobAction;
  deduped: boolean;
  skipped: boolean;
  priority: number;
  runAfter: string;
  dedupeKey: string;
}

export interface EnqueueScheduledFeedInput {
  store?: ScheduledFeedStore;
  env?: NodeJS.ProcessEnv;
  now?: Date | string;
  closedBarTs?: Date | string;
  config?: ScheduledFeedConfigOverrides;
  dryRun?: boolean;
}

export interface BuildScheduledFeedPlanInput {
  env?: NodeJS.ProcessEnv;
  now?: Date | string;
  closedBarTs?: Date | string;
  config?: ScheduledFeedConfigOverrides;
}

export interface EnqueueScheduledFeedResult {
  success: true;
  feedName: typeof SCHEDULED_FEED_NAME;
  dryRun: boolean;
  generatedAt: string;
  closedBarTs: string;
  symbols: string[];
  exchange: ScheduledFeedExchange;
  timeframe: ScheduledFeedTimeframe;
  source: ScheduledFeedSource;
  jobs: ScheduledFeedJobSummary[];
}

export interface SchedulerAuthorizationInput {
  headers: Pick<Headers, "get">;
  searchParams: Pick<URLSearchParams, "get">;
  env?: NodeJS.ProcessEnv;
  nodeEnv?: string;
}

export interface SchedulerAuthorizationResult {
  authorized: boolean;
  reason: "local_dry_run" | "secret" | "vercel_cron" | "missing_or_invalid_secret" | "unauthorized";
}
