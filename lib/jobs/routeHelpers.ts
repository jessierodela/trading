import type { JobRecord, JobStatus, JobStore } from "./jobStore";
import type { JobPayload, JobType } from "./types";
import { isJobType, validateJobPayload } from "./types";
import {
  isUsdtQuoteMarketSymbol,
  scheduledMarketIdentityErrorMessage,
} from "@/lib/dataQuality/marketIdentity";
import { DETERMINISTIC_REGIME_MODEL_VERSION, FEATURE_VERSION } from "@/lib/versions";

export type RouteExchange = "COINBASE" | "BINANCE" | "POLYGON";
export type RefreshTimeframe = "1h" | "1d";

export type RefreshRequest =
  | {
      type: "dashboard";
      dedupe?: boolean;
    }
  | {
      type: "regime";
      symbols: string[];
      exchange?: RouteExchange;
      timeframe?: RefreshTimeframe;
    }
  | {
      type: "market";
      symbols: string[];
      exchange: RouteExchange;
      timeframe: RefreshTimeframe;
      source: "coinbase" | "polygon";
    }
  | {
      type: "features";
      symbols: string[];
      exchange: RouteExchange;
      timeframe: RefreshTimeframe;
    }
  | {
      type: "strategies";
      symbols: string[];
      exchange: RouteExchange;
      timeframe: "1h";
      strategyIds?: string[];
    };

export interface BuiltRefreshJob {
  payload: JobPayload;
  dedupeKey: string | null;
  message: string;
}

export interface EnqueueJobForRouteResult {
  job: JobRecord;
  deduped: boolean;
}

const EXCHANGES: RouteExchange[] = ["COINBASE", "BINANCE", "POLYGON"];
const TIMEFRAMES: RefreshTimeframe[] = ["1h", "1d"];
const ACTIVE_STATUSES: JobStatus[] = ["queued", "running"];

export class UnsupportedScheduledMarketSymbolError extends Error {
  readonly code = "UNSUPPORTED_SCHEDULED_MARKET_SYMBOL";

  constructor(symbol: string) {
    super(scheduledMarketIdentityErrorMessage(symbol));
    this.name = "UnsupportedScheduledMarketSymbolError";
  }
}

export function isUnsupportedScheduledMarketSymbolError(err: unknown): err is UnsupportedScheduledMarketSymbolError {
  return err instanceof UnsupportedScheduledMarketSymbolError;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizePlainSymbol(value: string): string {
  return value.trim().toUpperCase().replace("/", "-");
}

function normalizeSymbols(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "symbols must be a non-empty string array" };
  }
  const symbols = value.map((item) => typeof item === "string" ? normalizePlainSymbol(item) : "");
  if (symbols.some((symbol) => symbol.length === 0)) {
    return { error: "symbols must contain only non-empty strings" };
  }
  return [...new Set(symbols)].sort((a, b) => a.localeCompare(b));
}

function parseStringArray(value: unknown, label: string): string[] | { error: string } {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    return { error: `${label} must be a string array when provided` };
  }
  return [...new Set(value.map((item) => item.trim()))].sort((a, b) => a.localeCompare(b));
}

function parseExchange(value: unknown, fallback?: RouteExchange): RouteExchange | { error: string } {
  const exchange = typeof value === "string" ? value.toUpperCase() : fallback;
  if (!exchange || !EXCHANGES.includes(exchange as RouteExchange)) {
    return { error: `exchange must be one of ${EXCHANGES.join(", ")}` };
  }
  return exchange as RouteExchange;
}

function parseTimeframe(value: unknown, fallback?: RefreshTimeframe): RefreshTimeframe | { error: string } {
  const timeframe = typeof value === "string" ? value : fallback;
  if (!timeframe || !TIMEFRAMES.includes(timeframe as RefreshTimeframe)) {
    return { error: `timeframe must be one of ${TIMEFRAMES.join(", ")}` };
  }
  return timeframe as RefreshTimeframe;
}

function csv(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(",") : "all";
}

export function hasRouteDatabaseUrl(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SUPABASE_DB_URL ?? env.DATABASE_URL);
}

export function routeDatabaseUnavailableError(): string {
  return "SUPABASE_DB_URL or DATABASE_URL must be set to enqueue or inspect jobs";
}

export function normalizeRegimeSymbol(value: string | null | undefined): string {
  const input = value && value.trim().length > 0 ? value : "BTC";
  if (isUsdtQuoteMarketSymbol(input)) {
    throw new UnsupportedScheduledMarketSymbolError(input);
  }
  const raw = normalizePlainSymbol(input);
  if (raw.endsWith("-USD")) return raw;
  return `${raw}-USD`;
}

export function displayRefreshSymbol(value: string): string {
  const raw = normalizePlainSymbol(value && value.trim().length > 0 ? value : "BTC");
  return raw.endsWith("-USD") ? raw.replace(/-USD$/, "") : raw;
}

export function dedupeKeyForJob(payload: JobPayload): string {
  switch (payload.jobType) {
    case "dashboard.snapshot":
      return `dashboard.snapshot:${payload.snapshotType}`;
    case "regime.compute":
      return `regime.compute:${payload.exchange}:${payload.timeframe}:${csv(payload.symbols)}`;
    case "market.ingest.latest":
      return `market.ingest.latest:${payload.source}:${payload.exchange}:${payload.timeframe}:${csv(payload.symbols)}`;
    case "features.compute":
      return `features.compute:${payload.exchange}:${payload.timeframe}:${csv(payload.symbols)}:${payload.featureVersion}`;
    case "strategies.evaluate":
      return `strategies.evaluate:${payload.exchange}:${payload.timeframe}:${csv(payload.symbols)}:${csv(payload.strategyIds)}`;
    case "paper.monitor":
      return `paper.monitor:${payload.exchange ?? "default"}:${payload.timeframe}:${csv(payload.symbols)}`;
    case "telegram.refresh":
      return `telegram.refresh:${payload.chatId}:${payload.symbol ?? "default"}`;
  }
}

export function buildDashboardRefreshJob(input: {
  dedupe?: boolean;
  symbols?: string[];
} = {}): BuiltRefreshJob {
  const payload: JobPayload = {
    jobType: "dashboard.snapshot",
    snapshotType: "dashboard",
    ...(input.symbols && input.symbols.length > 0 ? { symbols: input.symbols.map(normalizePlainSymbol) } : {}),
  };
  validateJobPayload(payload);
  return {
    payload,
    dedupeKey: input.dedupe === false ? null : dedupeKeyForJob(payload),
    message: "Dashboard refresh queued",
  };
}

export function buildRegimeRefreshJob(input: {
  symbol?: string | null;
  exchange?: RouteExchange;
  timeframe?: RefreshTimeframe;
} = {}): BuiltRefreshJob {
  const symbol = normalizeRegimeSymbol(input.symbol);
  const payload: JobPayload = {
    jobType: "regime.compute",
    symbols: [symbol],
    exchange: input.exchange ?? "COINBASE",
    timeframe: input.timeframe ?? "1h",
    regimeModelVersion: DETERMINISTIC_REGIME_MODEL_VERSION,
    source: "persisted_features",
  };
  validateJobPayload(payload);
  return {
    payload,
    dedupeKey: dedupeKeyForJob(payload),
    message: "Regime compute queued",
  };
}

export function buildTelegramRefreshJob(input: {
  symbol?: string | null;
} = {}): BuiltRefreshJob {
  const symbol = normalizeRegimeSymbol(input.symbol);
  return buildDashboardRefreshJob({ symbols: [symbol] });
}

export function buildRefreshJobRequest(body: unknown): BuiltRefreshJob | { error: string } {
  const obj = asRecord(body);
  if (!obj || typeof obj.type !== "string") return { error: "type is required" };

  switch (obj.type) {
    case "dashboard":
      return buildDashboardRefreshJob({ dedupe: obj.dedupe !== false });

    case "regime": {
      const symbols = normalizeSymbols(obj.symbols);
      if ("error" in symbols) return symbols;
      const exchange = parseExchange(obj.exchange, "COINBASE");
      if (typeof exchange !== "string") return exchange;
      const timeframe = parseTimeframe(obj.timeframe, "1h");
      if (typeof timeframe !== "string") return timeframe;
      let regimeSymbols: string[];
      try {
        regimeSymbols = symbols.map((symbol) => normalizeRegimeSymbol(symbol));
      } catch (err) {
        if (isUnsupportedScheduledMarketSymbolError(err)) return { error: err.message };
        throw err;
      }
      const payload: JobPayload = {
        jobType: "regime.compute",
        symbols: regimeSymbols,
        exchange,
        timeframe,
        regimeModelVersion: DETERMINISTIC_REGIME_MODEL_VERSION,
        source: "persisted_features",
      };
      validateJobPayload(payload);
      return { payload, dedupeKey: dedupeKeyForJob(payload), message: "Regime compute queued" };
    }

    case "market": {
      const symbols = normalizeSymbols(obj.symbols);
      if ("error" in symbols) return symbols;
      const exchange = parseExchange(obj.exchange);
      if (typeof exchange !== "string") return exchange;
      const timeframe = parseTimeframe(obj.timeframe);
      if (typeof timeframe !== "string") return timeframe;
      if (obj.source !== "coinbase" && obj.source !== "polygon") {
        return { error: "source must be coinbase or polygon" };
      }
      const payload: JobPayload = {
        jobType: "market.ingest.latest",
        symbols,
        exchange,
        timeframe,
        source: obj.source,
        closedBarsOnly: true,
      };
      validateJobPayload(payload);
      return { payload, dedupeKey: dedupeKeyForJob(payload), message: "Market ingest queued" };
    }

    case "features": {
      const symbols = normalizeSymbols(obj.symbols);
      if ("error" in symbols) return symbols;
      const exchange = parseExchange(obj.exchange);
      if (typeof exchange !== "string") return exchange;
      const timeframe = parseTimeframe(obj.timeframe);
      if (typeof timeframe !== "string") return timeframe;
      const payload: JobPayload = {
        jobType: "features.compute",
        symbols,
        exchange,
        timeframe,
        featureVersion: FEATURE_VERSION,
      };
      validateJobPayload(payload);
      return { payload, dedupeKey: dedupeKeyForJob(payload), message: "Features compute queued" };
    }

    case "strategies": {
      const symbols = normalizeSymbols(obj.symbols);
      if ("error" in symbols) return symbols;
      const exchange = parseExchange(obj.exchange);
      if (typeof exchange !== "string") return exchange;
      if (obj.timeframe !== "1h") return { error: "timeframe must be 1h for strategies" };
      let strategyIds: string[] | undefined;
      if (obj.strategyIds !== undefined) {
        const parsed = parseStringArray(obj.strategyIds, "strategyIds");
        if ("error" in parsed) return parsed;
        strategyIds = parsed;
      }
      const payload: JobPayload = {
        jobType: "strategies.evaluate",
        symbols,
        exchange,
        timeframe: "1h",
        ...(strategyIds ? { strategyIds } : {}),
      };
      validateJobPayload(payload);
      return { payload, dedupeKey: dedupeKeyForJob(payload), message: "Strategies evaluate queued" };
    }

    default:
      return { error: `unsupported refresh job type: ${obj.type}` };
  }
}

export async function enqueueJobForRoute(
  store: Pick<JobStore, "enqueueJob" | "listJobs">,
  payload: JobPayload,
  options: {
    dedupeKey?: string | null;
    priority?: number;
    maxAttempts?: number;
  } = {},
): Promise<EnqueueJobForRouteResult> {
  const dedupeKey = options.dedupeKey ?? null;
  if (dedupeKey) {
    const active = await store.listJobs({
      status: ACTIVE_STATUSES,
      jobType: payload.jobType,
      limit: 50,
    });
    const existing = active.find((job) => job.dedupeKey === dedupeKey);
    if (existing) return { job: existing, deduped: true };
  }

  const job = await store.enqueueJob(payload, {
    dedupeKey: dedupeKey ?? undefined,
    priority: options.priority,
    maxAttempts: options.maxAttempts,
  });
  return { job, deduped: false };
}

export function jobTypeFromQuery(value: string | null): JobType | { error: string } | undefined {
  if (value === null) return undefined;
  if (!isJobType(value)) return { error: `jobType must be one of the known P8 job types` };
  return value;
}
