import { DETERMINISTIC_REGIME_MODEL_VERSION, FEATURE_VERSION } from "@/lib/versions";
import {
  isUsdtQuoteMarketSymbol,
  scheduledMarketIdentityErrorMessage,
} from "@/lib/dataQuality/marketIdentity";
import type { JobRecord, JobStatus } from "@/lib/jobs/jobStore";
import type { JobPayload } from "@/lib/jobs/types";
import { validateJobPayload } from "@/lib/jobs/types";
import {
  canonicalIso,
  closedBarDedupeSuffix,
  closedBarRunAfter,
  floorToClosedBar,
} from "./closedBar";
import {
  DEFAULT_SCHEDULED_FEED_EXCHANGE,
  DEFAULT_SCHEDULED_FEED_SOURCE,
  DEFAULT_SCHEDULED_FEED_SYMBOLS,
  DEFAULT_SCHEDULED_FEED_TIMEFRAME,
  SCHEDULED_FEED_NAME,
  type BuildScheduledFeedPlanInput,
  type EnqueueScheduledFeedInput,
  type EnqueueScheduledFeedResult,
  type ScheduledFeedConfig,
  type ScheduledFeedConfigOverrides,
  type ScheduledFeedExchange,
  type ScheduledFeedJobSummary,
  type ScheduledFeedPlan,
  type ScheduledFeedSource,
  type ScheduledFeedStageDefinition,
  type ScheduledFeedStageName,
  type ScheduledFeedStagePlan,
  type ScheduledFeedStore,
  type ScheduledFeedTimeframe,
  type SchedulerAuthorizationInput,
  type SchedulerAuthorizationResult,
} from "./types";

/**
 * daily.market.ingest.latest / daily.features.compute keep the 1D higher-
 * timeframe context (used by regime/strategy/dashboard interpretation) fresh.
 * They dedupe against the closed DAILY bar, not the closed hourly bar, so on
 * an hourly cron cadence they only actually do work once per UTC day and
 * skip_succeeded the rest of the time. They deliberately stop at
 * features.compute — regime.compute/strategies.evaluate/paper.monitor stay
 * 1h-only (see ScheduledFeedTimeframe / JobPayload timeframe constraints).
 */
const SCHEDULED_STAGE_DEFINITIONS: ScheduledFeedStageDefinition[] = [
  { stage: "daily.market.ingest.latest", jobType: "market.ingest.latest", priority: 5, offsetMinutes: 1 },
  { stage: "daily.features.compute", jobType: "features.compute", priority: 7, offsetMinutes: 3 },
  { stage: "market.ingest.latest", jobType: "market.ingest.latest", priority: 10, offsetMinutes: 5 },
  { stage: "features.compute", jobType: "features.compute", priority: 20, offsetMinutes: 7 },
  { stage: "regime.compute", jobType: "regime.compute", priority: 30, offsetMinutes: 9 },
  { stage: "strategies.evaluate", jobType: "strategies.evaluate", priority: 40, offsetMinutes: 11 },
  { stage: "paper.monitor", jobType: "paper.monitor", priority: 50, offsetMinutes: 13 },
  { stage: "dashboard.snapshot", jobType: "dashboard.snapshot", priority: 60, offsetMinutes: 15 },
];

const DAILY_CONTEXT_STAGES: ReadonlySet<ScheduledFeedStageName> = new Set([
  "daily.market.ingest.latest",
  "daily.features.compute",
]);

const EXCHANGES: ScheduledFeedExchange[] = ["COINBASE", "BINANCE", "POLYGON"];
const SOURCES: ScheduledFeedSource[] = ["coinbase", "polygon"];
const TIMEFRAMES: ScheduledFeedTimeframe[] = ["1h"];
const ACTIVE_STATUSES: JobStatus[] = ["queued", "running"];

function csv(values: string[]): string {
  return values.join(",");
}

function normalizeSymbol(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (isUsdtQuoteMarketSymbol(trimmed)) {
    throw new Error(scheduledMarketIdentityErrorMessage(trimmed));
  }
  const normalized = trimmed.toUpperCase().replace("/", "-");
  return normalized.includes("-") ? normalized : `${normalized}-USD`;
}

function parseSymbols(value: string[] | string | undefined): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [...DEFAULT_SCHEDULED_FEED_SYMBOLS];
  const symbols = raw.map(normalizeSymbol).filter((symbol) => symbol.length > 0);
  const unique = symbols.filter((symbol, index) => symbols.indexOf(symbol) === index);
  if (unique.length === 0) throw new Error("scheduled feed requires at least one symbol");
  return unique;
}

function parseExchange(value: string | undefined): ScheduledFeedExchange {
  const exchange = (value ?? DEFAULT_SCHEDULED_FEED_EXCHANGE).trim().toUpperCase();
  if (!EXCHANGES.includes(exchange as ScheduledFeedExchange)) {
    throw new Error(`SCHEDULED_FEED_EXCHANGE must be one of ${EXCHANGES.join(", ")}`);
  }
  return exchange as ScheduledFeedExchange;
}

function parseTimeframe(value: string | undefined): ScheduledFeedTimeframe {
  const timeframe = (value ?? DEFAULT_SCHEDULED_FEED_TIMEFRAME).trim();
  if (!TIMEFRAMES.includes(timeframe as ScheduledFeedTimeframe)) {
    throw new Error("SCHEDULED_FEED_TIMEFRAME must be 1h for the bootstrap scheduler");
  }
  return timeframe as ScheduledFeedTimeframe;
}

function parseSource(value: string | undefined): ScheduledFeedSource {
  const source = (value ?? DEFAULT_SCHEDULED_FEED_SOURCE).trim().toLowerCase();
  if (!SOURCES.includes(source as ScheduledFeedSource)) {
    throw new Error(`SCHEDULED_FEED_SOURCE must be one of ${SOURCES.join(", ")}`);
  }
  return source as ScheduledFeedSource;
}

export function resolveScheduledFeedConfig(
  overrides: ScheduledFeedConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ScheduledFeedConfig {
  return {
    symbols: parseSymbols(overrides.symbols ?? env.SCHEDULED_FEED_SYMBOLS),
    exchange: parseExchange(overrides.exchange ?? env.SCHEDULED_FEED_EXCHANGE),
    timeframe: parseTimeframe(overrides.timeframe ?? env.SCHEDULED_FEED_TIMEFRAME),
    source: parseSource(overrides.source ?? env.SCHEDULED_FEED_SOURCE),
  };
}

function payloadForStage(
  stage: ScheduledFeedStageName,
  config: ScheduledFeedConfig,
): JobPayload {
  switch (stage) {
    case "daily.market.ingest.latest":
      return {
        jobType: "market.ingest.latest",
        symbols: config.symbols,
        exchange: config.exchange,
        timeframe: "1d",
        source: config.source,
        closedBarsOnly: true,
      };
    case "daily.features.compute":
      return {
        jobType: "features.compute",
        symbols: config.symbols,
        exchange: config.exchange,
        timeframe: "1d",
        featureVersion: FEATURE_VERSION,
      };
    case "market.ingest.latest":
      return {
        jobType: "market.ingest.latest",
        symbols: config.symbols,
        exchange: config.exchange,
        timeframe: config.timeframe,
        source: config.source,
        closedBarsOnly: true,
      };
    case "features.compute":
      return {
        jobType: "features.compute",
        symbols: config.symbols,
        exchange: config.exchange,
        timeframe: config.timeframe,
        featureVersion: FEATURE_VERSION,
      };
    case "regime.compute":
      return {
        jobType: "regime.compute",
        symbols: config.symbols,
        exchange: config.exchange,
        timeframe: config.timeframe,
        regimeModelVersion: DETERMINISTIC_REGIME_MODEL_VERSION,
        source: "persisted_features",
      };
    case "strategies.evaluate":
      return {
        jobType: "strategies.evaluate",
        symbols: config.symbols,
        exchange: config.exchange,
        timeframe: config.timeframe,
      };
    case "paper.monitor":
      return {
        jobType: "paper.monitor",
        symbols: config.symbols,
        exchange: config.exchange,
        timeframe: config.timeframe,
      };
    case "dashboard.snapshot":
      return {
        jobType: "dashboard.snapshot",
        snapshotType: "dashboard",
      };
  }
}

function dedupeKeyForStage(
  stage: ScheduledFeedStageName,
  payload: JobPayload,
  closedBarTs: string,
  symbolsCsv: string,
): string {
  const suffix = closedBarDedupeSuffix(closedBarTs);
  switch (stage) {
    case "daily.market.ingest.latest":
      if (payload.jobType !== "market.ingest.latest") break;
      return `scheduled:daily.market.ingest.latest:${payload.source}:${payload.exchange}:${payload.timeframe}:${suffix}:${symbolsCsv}`;
    case "daily.features.compute":
      if (payload.jobType !== "features.compute") break;
      return `scheduled:daily.features.compute:${payload.exchange}:${payload.timeframe}:${suffix}:${symbolsCsv}:${payload.featureVersion}`;
    case "market.ingest.latest":
      if (payload.jobType !== "market.ingest.latest") break;
      return `scheduled:market.ingest.latest:${payload.source}:${payload.exchange}:${payload.timeframe}:${suffix}:${symbolsCsv}`;
    case "features.compute":
      if (payload.jobType !== "features.compute") break;
      return `scheduled:features.compute:${payload.exchange}:${payload.timeframe}:${suffix}:${symbolsCsv}:${payload.featureVersion}`;
    case "regime.compute":
      if (payload.jobType !== "regime.compute") break;
      return `scheduled:regime.compute:${payload.exchange}:${payload.timeframe}:${suffix}:${symbolsCsv}:${payload.regimeModelVersion}`;
    case "strategies.evaluate":
      if (payload.jobType !== "strategies.evaluate") break;
      return `scheduled:strategies.evaluate:${payload.exchange}:${payload.timeframe}:${suffix}:${symbolsCsv}:all`;
    case "paper.monitor":
      if (payload.jobType !== "paper.monitor") break;
      return `scheduled:paper.monitor:${payload.exchange ?? "default"}:${payload.timeframe}:${suffix}:${symbolsCsv}`;
    case "dashboard.snapshot":
      if (payload.jobType !== "dashboard.snapshot") break;
      return `scheduled:dashboard.snapshot:${payload.snapshotType}:${suffix}`;
  }
  throw new Error(`unable to build dedupe key for stage ${stage}`);
}

export function buildScheduledFeedPlan(input: BuildScheduledFeedPlanInput = {}): ScheduledFeedPlan {
  const now = input.now ?? new Date();
  const generatedAt = canonicalIso(now);
  const config = resolveScheduledFeedConfig(input.config, input.env);
  const closedBarTs = input.closedBarTs
    ? canonicalIso(input.closedBarTs)
    : floorToClosedBar(now, config.timeframe);
  const dailyClosedBarTs = input.dailyClosedBarTs
    ? canonicalIso(input.dailyClosedBarTs)
    : floorToClosedBar(now, "1d");
  const symbolsCsv = csv(config.symbols);

  const stages: ScheduledFeedStagePlan[] = SCHEDULED_STAGE_DEFINITIONS.map((definition) => {
    const payload = validateJobPayload(payloadForStage(definition.stage, config));
    const stageClosedBarTs = DAILY_CONTEXT_STAGES.has(definition.stage) ? dailyClosedBarTs : closedBarTs;
    return {
      ...definition,
      payload,
      dedupeKey: dedupeKeyForStage(definition.stage, payload, stageClosedBarTs, symbolsCsv),
      runAfter: closedBarRunAfter(stageClosedBarTs, definition.offsetMinutes),
    };
  });

  return {
    feedName: SCHEDULED_FEED_NAME,
    generatedAt,
    closedBarTs,
    dailyClosedBarTs,
    symbols: config.symbols,
    exchange: config.exchange,
    timeframe: config.timeframe,
    source: config.source,
    stages,
  };
}

async function findJobByDedupe(
  store: ScheduledFeedStore,
  stage: ScheduledFeedStagePlan,
  status: JobStatus | JobStatus[],
): Promise<JobRecord | null> {
  const jobs = await store.listJobs({
    jobType: stage.jobType,
    status,
    limit: 100,
  });
  return jobs.find((job) => job.dedupeKey === stage.dedupeKey) ?? null;
}

function summaryForJob(
  stage: ScheduledFeedStagePlan,
  job: JobRecord | null,
  action: ScheduledFeedJobSummary["action"],
): ScheduledFeedJobSummary {
  return {
    stage: stage.stage,
    jobType: stage.jobType,
    jobId: job?.publicId ?? null,
    status: action === "dry_run" ? "dry_run" : job?.status ?? "queued",
    action,
    deduped: action === "deduped",
    skipped: action === "skipped_succeeded",
    priority: stage.priority,
    runAfter: stage.runAfter,
    dedupeKey: stage.dedupeKey,
  };
}

export async function enqueueScheduledFeed(
  input: EnqueueScheduledFeedInput = {},
): Promise<EnqueueScheduledFeedResult> {
  const plan = buildScheduledFeedPlan(input);
  const dryRun = input.dryRun === true;
  const jobs: ScheduledFeedJobSummary[] = [];

  if (!dryRun && !input.store) {
    throw new Error("scheduled feed enqueue requires a job store unless dryRun=true");
  }

  for (const stage of plan.stages) {
    if (dryRun) {
      jobs.push(summaryForJob(stage, null, "dry_run"));
      continue;
    }

    const store = input.store as ScheduledFeedStore;
    const succeeded = await findJobByDedupe(store, stage, "succeeded");
    if (succeeded) {
      jobs.push(summaryForJob(stage, succeeded, "skipped_succeeded"));
      continue;
    }

    const active = await findJobByDedupe(store, stage, ACTIVE_STATUSES);
    if (active) {
      jobs.push(summaryForJob(stage, active, "deduped"));
      continue;
    }

    const job = await store.enqueueJob(stage.payload, {
      priority: stage.priority,
      dedupeKey: stage.dedupeKey,
      runAfter: stage.runAfter,
    });
    jobs.push(summaryForJob(stage, job, "enqueued"));
  }

  return {
    success: true,
    feedName: plan.feedName,
    dryRun,
    generatedAt: plan.generatedAt,
    closedBarTs: plan.closedBarTs,
    dailyClosedBarTs: plan.dailyClosedBarTs,
    symbols: plan.symbols,
    exchange: plan.exchange,
    timeframe: plan.timeframe,
    source: plan.source,
    jobs,
  };
}

export function authorizeSchedulerRequest(
  input: SchedulerAuthorizationInput,
): SchedulerAuthorizationResult {
  const env = input.env ?? process.env;
  const dryRun = input.searchParams.get("dryRun") === "1";
  const nodeEnv = input.nodeEnv ?? env.NODE_ENV;
  if (dryRun && nodeEnv !== "production") {
    return { authorized: true, reason: "local_dry_run" };
  }

  const secret = env.SCHEDULER_SECRET?.trim();
  if (secret) {
    const auth = input.headers.get("authorization") ?? input.headers.get("Authorization");
    const querySecret = input.searchParams.get("secret");
    if (auth === `Bearer ${secret}` || querySecret === secret) {
      return { authorized: true, reason: "secret" };
    }
    return { authorized: false, reason: "missing_or_invalid_secret" };
  }

  const userAgent = input.headers.get("user-agent") ?? input.headers.get("User-Agent") ?? "";
  if (userAgent.toLowerCase().includes("vercel-cron")) {
    return { authorized: true, reason: "vercel_cron" };
  }

  return { authorized: false, reason: "unauthorized" };
}
