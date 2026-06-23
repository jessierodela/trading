import { fetchCandlesRange } from "@/lib/data/coinbaseRest";
import type { MarketIngestLatestPipelineInput, MarketIngestLatestPipelineResult } from "@/lib/pipeline/types";
import type { Bar, Timeframe } from "@/lib/quant/types";
import { DATA_SOURCE_COINBASE_REST } from "@/lib/versions";

const TIMEFRAME_MS: Record<Extract<Timeframe, "1h" | "1d">, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

function floorToTimeframe(date: Date, timeframe: Extract<Timeframe, "1h" | "1d">): Date {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  if (timeframe === "1d") d.setUTCHours(0, 0, 0, 0);
  return d;
}

function minIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function ensureIso(label: string, value: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function isClosedBar(bar: Bar, timeframe: Extract<Timeframe, "1h" | "1d">, endTs: string): boolean {
  const tsMs = Date.parse(bar.ts);
  const endMs = Date.parse(endTs);
  return Number.isFinite(tsMs) && tsMs + TIMEFRAME_MS[timeframe] <= endMs;
}

async function defaultFetchBars(
  input: Parameters<NonNullable<MarketIngestLatestPipelineInput["fetchBarsFn"]>>[0],
): Promise<Bar[]> {
  if (input.source !== "coinbase" || input.exchange !== "COINBASE") {
    throw new Error("default market ingest fetcher supports only Coinbase REST with exchange=COINBASE");
  }
  return fetchCandlesRange(input.symbol, input.timeframe, input.startTs, input.endTs);
}

function dataSourceVersionFor(input: MarketIngestLatestPipelineInput): string {
  if (input.dataSourceVersion) return input.dataSourceVersion;
  if (input.source === "coinbase") return DATA_SOURCE_COINBASE_REST;
  return "polygon.rest.v1";
}

export async function runMarketIngestLatestPipeline(
  input: MarketIngestLatestPipelineInput,
): Promise<MarketIngestLatestPipelineResult> {
  if (input.closedBarsOnly !== true) {
    throw new Error("market.ingest.latest requires closedBarsOnly=true");
  }
  if (input.symbols.length === 0) {
    throw new Error("market.ingest.latest requires at least one symbol");
  }

  ensureIso("startTs", input.startTs);
  if (input.endTs) ensureIso("endTs", input.endTs);

  const now = input.now ?? (() => new Date());
  const closedBoundary = floorToTimeframe(now(), input.timeframe).toISOString();
  const endTs = input.endTs ? minIso(input.endTs, closedBoundary) : closedBoundary;
  const fetchBarsFn = input.fetchBarsFn ?? defaultFetchBars;
  const dataSourceVersion = dataSourceVersionFor(input);

  if (Date.parse(input.startTs) >= Date.parse(endTs)) {
    return {
      success: true,
      source: input.source,
      exchange: input.exchange,
      timeframe: input.timeframe,
      closedBarsOnly: true,
      fetchedBars: 0,
      insertedBars: 0,
      skippedBars: 0,
      latestTs: null,
      symbols: Object.fromEntries(
        input.symbols.map((symbol) => [
          symbol,
          { fetchedBars: 0, insertedBars: 0, skippedBars: 0, latestTs: null },
        ]),
      ),
    };
  }

  let fetchedBars = 0;
  let insertedBars = 0;
  let skippedBars = 0;
  let latestTs: string | null = null;
  const symbols: MarketIngestLatestPipelineResult["symbols"] = {};

  for (const symbol of input.symbols) {
    const rawBars = await fetchBarsFn({
      symbol,
      exchange: input.exchange,
      timeframe: input.timeframe,
      source: input.source,
      startTs: input.startTs,
      endTs,
    });

    const closedBars = rawBars.filter(
      (bar) =>
        bar.symbol === symbol &&
        bar.exchange === input.exchange &&
        bar.timeframe === input.timeframe &&
        isClosedBar(bar, input.timeframe, endTs),
    );
    const inserted = await input.barStore.insertMany(closedBars, dataSourceVersion, {
      onConflict: "ignore",
    });
    const skipped = rawBars.length - inserted;
    const symbolLatestTs =
      closedBars.length > 0
        ? closedBars.map((bar) => bar.ts).sort((a, b) => b.localeCompare(a))[0]
        : null;

    fetchedBars += rawBars.length;
    insertedBars += inserted;
    skippedBars += skipped;
    if (symbolLatestTs !== null && (latestTs === null || symbolLatestTs > latestTs)) {
      latestTs = symbolLatestTs;
    }
    symbols[symbol] = {
      fetchedBars: rawBars.length,
      insertedBars: inserted,
      skippedBars: skipped,
      latestTs: symbolLatestTs,
    };
  }

  return {
    success: true,
    source: input.source,
    exchange: input.exchange,
    timeframe: input.timeframe,
    closedBarsOnly: true,
    fetchedBars,
    insertedBars,
    skippedBars,
    latestTs,
    symbols,
  };
}
