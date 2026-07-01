import { fetchCandlesRange } from "@/lib/data/coinbaseRest";
import { validateBarQuality } from "@/lib/dataQuality/barQuality";
import { normalizeMarketIdentity } from "@/lib/dataQuality/marketIdentity";
import { DataQualityGateError, jobDataQualitySummary } from "@/lib/dataQuality/qualityGate";
import type { DataQualityReport } from "@/lib/dataQuality/types";
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
  const volumePolicy = input.volumePolicy ?? "required";

  if (Date.parse(input.startTs) >= Date.parse(endTs)) {
    const dataQuality = jobDataQualitySummary({
      scope: "market.ingest.latest",
      checkedAt: now().toISOString(),
      reports: [],
      checkedBars: 0,
      passedBars: 0,
      warnedBars: 0,
      blockedBars: 0,
    });
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
      dataQuality,
      symbols: Object.fromEntries(
        input.symbols.map((symbol) => [
          symbol,
          { fetchedBars: 0, insertedBars: 0, skippedBars: 0, latestTs: null, dataQuality },
        ]),
      ),
    };
  }

  let fetchedBars = 0;
  let insertedBars = 0;
  let skippedBars = 0;
  let latestTs: string | null = null;
  const symbols: MarketIngestLatestPipelineResult["symbols"] = {};
  const allReports: DataQualityReport[] = [];
  let checkedBars = 0;
  let passedBars = 0;
  let warnedBars = 0;
  let blockedBars = 0;

  for (const symbol of input.symbols) {
    const expectedIdentity = normalizeMarketIdentity({
      symbol,
      exchange: input.exchange,
      source: input.source,
    });
    const rawBars = await fetchBarsFn({
      symbol,
      exchange: input.exchange,
      timeframe: input.timeframe,
      source: input.source,
      startTs: input.startTs,
      endTs,
    });

    const reports = rawBars.map((bar) =>
      validateBarQuality({
        bar,
        expectedIdentity,
        timeframe: input.timeframe,
        now: now(),
        closedBarsOnly: true,
        volumePolicy,
        source: input.source,
      })
    );
    allReports.push(...reports);
    const trustedBars = rawBars.filter((_, index) => reports[index].severity !== "block");
    const inserted = await input.barStore.insertMany(trustedBars, dataSourceVersion, {
      onConflict: "ignore",
    });
    const blockedForSymbol = reports.filter((report) => report.severity === "block").length;
    const warnedForSymbol = reports.filter((report) => report.severity === "warn").length;
    const passedForSymbol = reports.filter((report) => report.severity === "pass").length;
    const skipped = rawBars.length - inserted;
    const symbolLatestTs =
      trustedBars.length > 0
        ? trustedBars.map((bar) => bar.ts).sort((a, b) => b.localeCompare(a))[0]
        : null;
    const symbolDataQuality = jobDataQualitySummary({
      scope: "market.ingest.latest.symbol",
      checkedAt: now().toISOString(),
      reports,
      checkedBars: rawBars.length,
      passedBars: passedForSymbol,
      warnedBars: warnedForSymbol,
      blockedBars: blockedForSymbol,
    });

    if (rawBars.length > 0 && trustedBars.length === 0 && blockedForSymbol > 0) {
      throw new DataQualityGateError(
        `all fetched bars blocked by data quality for ${symbol}`,
        symbolDataQuality,
        "market_ingest_all_bars_blocked",
      );
    }

    fetchedBars += rawBars.length;
    insertedBars += inserted;
    skippedBars += skipped;
    checkedBars += rawBars.length;
    passedBars += passedForSymbol;
    warnedBars += warnedForSymbol;
    blockedBars += blockedForSymbol;
    if (symbolLatestTs !== null && (latestTs === null || symbolLatestTs > latestTs)) {
      latestTs = symbolLatestTs;
    }
    symbols[symbol] = {
      fetchedBars: rawBars.length,
      insertedBars: inserted,
      skippedBars: skipped,
      latestTs: symbolLatestTs,
      dataQuality: symbolDataQuality,
    };
  }

  const dataQuality = jobDataQualitySummary({
    scope: "market.ingest.latest",
    checkedAt: now().toISOString(),
    reports: allReports,
    checkedBars,
    passedBars,
    warnedBars,
    blockedBars,
  });

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
    dataQuality,
    symbols,
  };
}
