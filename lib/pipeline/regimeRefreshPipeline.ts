import { DEFAULT_INDICATOR_CONFIG } from "@/config/indicators";
import { DEFAULT_INDICATOR_CONFIG_1D } from "@/config/indicators1d";
import { runRegimeDetector } from "@/lib/agents/regimeDetector";
import type { CacheSnapshot, CachedSymbolData } from "@/lib/indicatorCache";
import type { CacheSnapshot1d, CachedSymbolData1d } from "@/lib/indicatorCache1d";
import type {
  FeatureSnapshotRegimeBridgeInput,
  FeatureSnapshotRegimeBridgeOutput,
  RegimeAsset,
  RegimeRefreshPipelineInput,
  RegimeRefreshPipelineResult,
} from "@/lib/pipeline/types";
import { fetchAllQuotes } from "@/lib/polygon";
import type { FeatureSnapshot } from "@/lib/quant/types";
import { mapRegimeToPermission } from "@/lib/regime/permissionMap";
import { fetchAllIndicators, type IndicatorValues } from "@/lib/taapi";
import { fetchAllIndicators1d } from "@/lib/taapi1d";

interface Cache1dEntry {
  data: Map<string, IndicatorValues>;
  fetchedOnDate: string;
}

const cache1d = new Map<string, Cache1dEntry>();
const DEFAULT_WAIT_BEFORE_1D_MS = 16_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utcDateString(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function assetTypeForSymbol(symbol: string): "crypto" | "stock" {
  return ["BTC", "ETH", "SOL"].includes(symbol) || symbol.endsWith("-USD")
    ? "crypto"
    : "stock";
}

async function get1dIndicators(
  symbol: string,
  assets: RegimeAsset[],
  input: Required<Pick<RegimeRefreshPipelineInput, "sleepMs" | "now" | "waitBefore1dMs" | "fetchIndicators1dFn">>,
): Promise<Map<string, IndicatorValues>> {
  const today = utcDateString(input.now());
  const cached = cache1d.get(symbol);

  if (cached && cached.fetchedOnDate === today) {
    console.log(
      `[regime/refresh] 1D cache hit for ${symbol} ` +
        `(fetched today ${today}) - skipping taapi 1D fetch`,
    );
    return cached.data;
  }

  console.log(
    `[regime/refresh] 1D cache cold for ${symbol} ` +
      `(last fetched: ${cached?.fetchedOnDate ?? "never"}) - ` +
      `waiting 16s before 1D fetch to clear taapi rate-limit...`,
  );
  await input.sleepMs(input.waitBefore1dMs);

  try {
    const data = await input.fetchIndicators1dFn(assets, DEFAULT_INDICATOR_CONFIG_1D);
    cache1d.set(symbol, { data, fetchedOnDate: today });
    console.log(`[regime/refresh] 1D indicators fetched and cached for ${symbol} (${today})`);
    return data;
  } catch (err) {
    console.warn(
      `[regime/refresh] 1D fetch failed for ${symbol} - ` +
        `using 1H-only context this call: ${err}`,
    );
    return new Map();
  }
}

function computeDerived(i: IndicatorValues): CachedSymbolData["derived"] {
  const hist = i.macd?.valueMACDHist ?? null;
  return {
    priceAboveEma20:
      i.ema20 != null && i.currentClose != null ? i.currentClose > i.ema20 : null,
    ema20Slope:
      i.ema20 != null && i.prevEma20 != null ? i.ema20 - i.prevEma20 : null,
    ema20PctDist:
      i.ema20 != null && i.currentClose != null && i.ema20 > 0
        ? +((((i.currentClose - i.ema20) / i.ema20) * 100).toFixed(2))
        : null,
    histChange:
      hist != null && i.prevHist != null ? +((hist - i.prevHist).toFixed(6)) : null,
    rsiChange:
      i.rsi != null && i.prevRsi != null ? +((i.rsi - i.prevRsi).toFixed(2)) : null,
    volumeChangePct:
      i.volume != null && i.prevVolume != null && i.prevVolume > 0
        ? +((((i.volume - i.prevVolume) / i.prevVolume) * 100).toFixed(2))
        : null,
    relativeVolume: null,
    volumeExpanding:
      i.volume != null && i.prevVolume != null ? i.volume > i.prevVolume : null,
    volumeAboveAverage: null,
    atrPct:
      i.atr != null && i.currentClose != null && i.currentClose > 0
        ? +(((i.atr / i.currentClose) * 100).toFixed(3))
        : null,
    distanceFromEmaInAtr:
      i.atr != null && i.atr > 0 && i.currentClose != null && i.ema20 != null
        ? +(((i.currentClose - i.ema20) / i.atr).toFixed(3))
        : null,
    candleRangeInAtr:
      i.atr != null && i.atr > 0 && i.high != null && i.low != null
        ? +(((i.high - i.low) / i.atr).toFixed(3))
        : null,
  };
}

function computeDerived1d(i: IndicatorValues): CachedSymbolData1d["derived"] {
  return {
    priceAboveEma50:
      i.currentClose != null && i.ema50 != null ? i.currentClose > i.ema50 : null,
    priceAboveEma200:
      i.currentClose != null && i.ema200 != null ? i.currentClose > i.ema200 : null,
    ema50AboveEma200:
      i.ema50 != null && i.ema200 != null ? i.ema50 > i.ema200 : null,
    ema50Slope:
      i.ema50 != null && i.prevEma50 != null ? +((i.ema50 - i.prevEma50).toFixed(4)) : null,
    ema200Slope:
      i.ema200 != null && i.prevEma200 != null
        ? +((i.ema200 - i.prevEma200).toFixed(4))
        : null,
  };
}

function previousFromSlope(value: number | null | undefined, slope: number | null | undefined): number | null {
  return value != null && slope != null ? value - slope : null;
}

function featureToIndicatorValues(feature: FeatureSnapshot): IndicatorValues {
  const macd =
    feature.macd != null || feature.macdSignal != null || feature.macdHist != null
      ? {
          valueMACD: feature.macd ?? 0,
          valueMACDSignal: feature.macdSignal ?? 0,
          valueMACDHist: feature.macdHist ?? 0,
        }
      : null;
  const bb =
    feature.bbLower != null && feature.bbMiddle != null && feature.bbUpper != null
      ? {
          valueLowerBand: feature.bbLower,
          valueMiddleBand: feature.bbMiddle,
          valueUpperBand: feature.bbUpper,
        }
      : null;

  return {
    symbol: feature.symbol,
    rsi: feature.rsi14 ?? null,
    macd,
    ema20: feature.ema20 ?? null,
    ema50: feature.ema50 ?? null,
    ema200: feature.ema200 ?? null,
    bb,
    bb_width: feature.bbWidth ?? null,
    bb_width_prev: feature.bbWidthPrev ?? null,
    atr: feature.atr14 ?? null,
    prevRsi: null,
    prevHist: null,
    prevEma20: previousFromSlope(feature.ema20, feature.ema20Slope),
    prevEma50: previousFromSlope(feature.ema50, feature.ema50Slope),
    prevEma200: previousFromSlope(feature.ema200, feature.ema200Slope),
    currentClose: feature.close,
    volume: null,
    prevVolume: null,
    volumeSma20: feature.volumeSma20 ?? null,
    high: null,
    low: null,
    open: null,
    atrAvg20: null,
  };
}

function latestBySymbol(features: FeatureSnapshot[]): Map<string, FeatureSnapshot> {
  const latest = new Map<string, FeatureSnapshot>();
  for (const feature of features) {
    const previous = latest.get(feature.symbol);
    if (!previous || feature.ts > previous.ts) latest.set(feature.symbol, feature);
  }
  return latest;
}

/**
 * P8B compatibility bridge.
 *
 * The existing Regime Detector still consumes the legacy indicator cache
 * snapshot shape. Future `regime.compute` workers should source data from
 * persisted `feature_snapshots`, so this bridge maps those persisted feature
 * rows into the detector-compatible snapshots without replacing A6 yet.
 *
 * Final target: a persisted-feature-native deterministic regime engine that
 * does not need this cache-shaped adapter.
 */
export function adaptFeatureSnapshotsToRegimeDetectorInput(
  input: FeatureSnapshotRegimeBridgeInput,
): FeatureSnapshotRegimeBridgeOutput {
  const now = input.now ?? (() => new Date());
  const latest1h = latestBySymbol(input.features1h);
  const latest1d = latestBySymbol(input.features1d ?? []);
  const stockSymbols: string[] = [];
  const cryptoSymbols: string[] = [];
  const data = new Map<string, CachedSymbolData>();
  const data1d = new Map<string, CachedSymbolData1d>();

  for (const [symbol, feature] of latest1h.entries()) {
    const indicators = featureToIndicatorValues(feature);
    const derived = computeDerived(indicators);
    data.set(symbol, {
      indicators,
      quote: null,
      derived: {
        ...derived,
        ema20Slope: feature.ema20Slope ?? derived.ema20Slope,
        ema20PctDist:
          feature.ema20 != null && feature.ema20 > 0
            ? +((((feature.close - feature.ema20) / feature.ema20) * 100).toFixed(2))
            : null,
        atrPct: feature.atrPct ?? derived.atrPct,
        distanceFromEmaInAtr: feature.distanceFromEma20Atr ?? derived.distanceFromEmaInAtr,
        candleRangeInAtr: feature.candleRangeAtr ?? derived.candleRangeInAtr,
        relativeVolume: feature.relativeVolume20 ?? null,
      },
    });
    if (assetTypeForSymbol(symbol) === "crypto") cryptoSymbols.push(symbol);
    else stockSymbols.push(symbol);
  }

  for (const [symbol, feature] of latest1d.entries()) {
    const indicators = featureToIndicatorValues(feature);
    const derived = computeDerived1d(indicators);
    data1d.set(symbol, {
      indicators,
      quote: null,
      derived: {
        ...derived,
        ema50Slope: feature.ema50Slope ?? derived.ema50Slope,
        ema200Slope: feature.ema200Slope ?? derived.ema200Slope,
      },
    });
  }

  const timestamp = now().toISOString();
  return {
    snapshot: {
      lastUpdated: timestamp,
      refreshing: false,
      lastFetchFailed: false,
      stockSymbols,
      cryptoSymbols,
      data,
    },
    snapshot1d: {
      lastUpdated: timestamp,
      refreshing: false,
      lastFetchFailed: data1d.size === 0,
      stockSymbols,
      cryptoSymbols,
      data: data1d,
    },
  };
}

export async function runRegimeRefreshPipeline(
  input: RegimeRefreshPipelineInput = {},
): Promise<RegimeRefreshPipelineResult> {
  const now = input.now ?? (() => new Date());
  const nowMs = input.nowMs ?? Date.now;
  const sleepMs = input.sleepMs ?? defaultSleep;
  const waitBefore1dMs = input.waitBefore1dMs ?? DEFAULT_WAIT_BEFORE_1D_MS;
  const fetchIndicatorsFn = input.fetchIndicatorsFn ?? fetchAllIndicators;
  const fetchIndicators1dFn = input.fetchIndicators1dFn ?? fetchAllIndicators1d;
  const fetchQuotesFn = input.fetchQuotesFn ?? fetchAllQuotes;
  const runRegimeDetectorFn = input.runRegimeDetectorFn ?? runRegimeDetector;
  const startMs = nowMs();
  const symbol = (input.symbol ?? "BTC").toUpperCase();

  console.log(`[regime/refresh] On-demand regime classification for ${symbol}`);

  const assetType = assetTypeForSymbol(symbol);
  const assets: RegimeAsset[] = [{ symbol, type: assetType }];

  let indicatorMap: Map<string, IndicatorValues>;
  let quoteMap: Awaited<ReturnType<typeof fetchAllQuotes>>;

  try {
    [indicatorMap, quoteMap] = await Promise.all([
      fetchIndicatorsFn(assets, DEFAULT_INDICATOR_CONFIG),
      fetchQuotesFn(assets),
    ]);
  } catch (err) {
    console.error("[regime/refresh] 1H indicator fetch failed:", err);
    return {
      ok: false,
      status: 500,
      body: { success: false, error: "Failed to fetch 1H indicators", detail: String(err) },
    };
  }

  const indicatorMap1d = await get1dIndicators(symbol, assets, {
    sleepMs,
    now,
    waitBefore1dMs,
    fetchIndicators1dFn,
  });

  const ind = indicatorMap.get(symbol);
  const quote = quoteMap.get(symbol) ?? null;
  const ind1d = indicatorMap1d.get(symbol);

  if (!ind) {
    console.error(`[regime/refresh] No indicator data returned for ${symbol}`);
    return {
      ok: false,
      status: 500,
      body: { success: false, error: `No indicator data for ${symbol}` },
    };
  }

  if (quote?.price != null) ind.currentClose = quote.price;
  if (quote?.volume != null) ind.volume = quote.volume;
  if (ind1d && quote?.price != null) ind1d.currentClose = quote.price;

  const snapshot: CacheSnapshot = {
    lastUpdated: now().toISOString(),
    refreshing: false,
    lastFetchFailed: false,
    stockSymbols: assetType === "stock" ? [symbol] : [],
    cryptoSymbols: assetType === "crypto" ? [symbol] : [],
    data: new Map([
      [
        symbol,
        {
          indicators: ind,
          quote,
          derived: computeDerived(ind),
        },
      ],
    ]),
  };

  const snapshot1d: CacheSnapshot1d = {
    lastUpdated: now().toISOString(),
    refreshing: false,
    lastFetchFailed: !ind1d,
    stockSymbols: assetType === "stock" ? [symbol] : [],
    cryptoSymbols: assetType === "crypto" ? [symbol] : [],
    data: ind1d
      ? new Map([
          [
            symbol,
            {
              indicators: ind1d,
              quote,
              derived: computeDerived1d(ind1d),
            },
          ],
        ])
      : new Map(),
  };

  let regimeSignals: Awaited<ReturnType<typeof runRegimeDetector>>;
  try {
    regimeSignals = await runRegimeDetectorFn(snapshot, snapshot1d, [symbol]);
  } catch (err) {
    console.error("[regime/refresh] Regime detector failed:", err);
    return {
      ok: false,
      status: 500,
      body: { success: false, error: "Regime detector failed", detail: String(err) },
    };
  }

  const signal = regimeSignals.find((s) => s.symbol === symbol);
  if (!signal) {
    console.error(`[regime/refresh] No regime signal produced for ${symbol}`);
    return {
      ok: false,
      status: 500,
      body: { success: false, error: `Regime detector produced no output for ${symbol}` },
    };
  }

  const mapped = mapRegimeToPermission(signal.regime, signal.reliability);
  const updatedAt = now().toISOString();
  const durationMs = nowMs() - startMs;

  const body = {
    success: true as const,
    symbol,
    regime: signal.regime,
    reliability: signal.reliability,
    directionalBias: mapped.directionalBias,
    tradePermission: mapped.tradePermission,
    edgeMultiplier: mapped.edgeMultiplier,
    sizeMultiplier: mapped.sizeMultiplier,
    emaContext: signal.emaContext,
    volContext: signal.volContext,
    reason: signal.reason,
    updatedAt,
  };

  console.log(
    `[regime/refresh] ${symbol} -> ${signal.regime} ` +
      `(reliability=${signal.reliability.toFixed(2)}, ` +
      `permission=${mapped.tradePermission}, ` +
      `1D cache: ${cache1d.get(symbol)?.fetchedOnDate === utcDateString(now()) ? "warm" : "cold"}, ` +
      `${durationMs}ms)`,
  );

  return {
    ok: true,
    status: 200,
    body,
  };
}

export function resetRegimeRefreshPipelineCacheForSmoke(): void {
  cache1d.clear();
}
