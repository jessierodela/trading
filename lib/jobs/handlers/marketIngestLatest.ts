import type { JobPayload } from "@/lib/jobs/types";
import { runMarketIngestLatestPipeline } from "@/lib/pipeline";
import type { Exchange, Timeframe } from "@/lib/quant/types";
import {
  handlerSuccess,
  invalidPayload,
  requireService,
  retryableFailure,
  type JobHandler,
} from "./types";

const TIMEFRAME_MS: Record<Extract<Timeframe, "1h" | "1d">, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

function isExchange(value: string): value is Exchange {
  return value === "COINBASE" || value === "BINANCE" || value === "POLYGON";
}

function closedBoundary(now: Date, timeframe: Extract<Timeframe, "1h" | "1d">): string {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  if (timeframe === "1d") d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function nextTs(ts: string, timeframe: Extract<Timeframe, "1h" | "1d">): string {
  return new Date(Date.parse(ts) + TIMEFRAME_MS[timeframe]).toISOString();
}

type MarketPayload = Extract<JobPayload, { jobType: "market.ingest.latest" }>;

export const handleMarketIngestLatest: JobHandler<MarketPayload> = async (payload, context) => {
  if (!isExchange(payload.exchange)) {
    return invalidPayload("market.ingest.latest exchange is not supported", { exchange: payload.exchange });
  }

  const barStore = requireService(context.services, "barStore", undefined);
  const runIngest = context.services.runMarketIngestLatestPipeline ?? runMarketIngestLatestPipeline;
  const endTs = closedBoundary(context.now(), payload.timeframe);
  let fetchedBars = 0;
  let insertedBars = 0;
  let skippedBars = 0;
  let latestTs: string | null = null;
  const symbols: Record<string, unknown> = {};

  try {
    for (const symbol of payload.symbols) {
      const currentLatest = await barStore.latestTs({
        symbol,
        exchange: payload.exchange,
        timeframe: payload.timeframe,
      });
      const startTs = currentLatest
        ? nextTs(currentLatest, payload.timeframe)
        : new Date(Date.parse(endTs) - TIMEFRAME_MS[payload.timeframe]).toISOString();

      const result = await runIngest({
        symbols: [symbol],
        exchange: payload.exchange,
        timeframe: payload.timeframe,
        source: payload.source,
        closedBarsOnly: true,
        startTs,
        endTs,
        barStore,
        now: context.now,
      });

      fetchedBars += result.fetchedBars;
      insertedBars += result.insertedBars;
      skippedBars += result.skippedBars;
      if (result.latestTs !== null && (latestTs === null || result.latestTs > latestTs)) {
        latestTs = result.latestTs;
      }
      symbols[symbol] = result.symbols[symbol] ?? null;
    }
  } catch (err) {
    return retryableFailure("market_ingest_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return handlerSuccess({
    jobType: payload.jobType,
    source: payload.source,
    exchange: payload.exchange,
    timeframe: payload.timeframe,
    closedBarsOnly: true,
    fetchedBars,
    insertedBars,
    skippedBars,
    latestTs,
    symbols,
  });
};
