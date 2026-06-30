import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  adaptFeatureSnapshotsToRegimeDetectorInput,
  resetRegimeRefreshPipelineCacheForSmoke,
  runDashboardRefreshPipeline,
  runMarketIngestLatestPipeline,
  runRegimeRefreshPipeline,
  writeDashboardSnapshot,
} from "@/lib/pipeline";
import { assertNoLiveExecutionJobTypes, FORBIDDEN_LIVE_JOB_TYPES, JOB_TYPES } from "@/lib/jobs";
import { InMemoryBarStore } from "@/lib/storage/barStore";
import type { CacheSnapshot } from "@/lib/indicatorCache";
import type { CacheSnapshot1d } from "@/lib/indicatorCache1d";
import type { Bar, FeatureSnapshot } from "@/lib/quant/types";
import type { IndicatorValues } from "@/lib/taapi";

let failed = 0;

function assert(label: string, cond: boolean, details?: unknown): void {
  if (!cond) {
    console.log(`FAIL: ${label}`);
    if (details !== undefined) console.log("       ", details);
    failed++;
  } else {
    console.log(`PASS: ${label}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? undefined : { actual, expected });
}

function indicator(symbol: string): IndicatorValues {
  return {
    symbol,
    rsi: 55,
    macd: { valueMACD: 1, valueMACDSignal: 0.5, valueMACDHist: 0.5 },
    ema20: 100,
    ema50: 95,
    ema200: 90,
    bb: { valueLowerBand: 90, valueMiddleBand: 100, valueUpperBand: 110 },
    bb_width: 0.2,
    bb_width_prev: 0.18,
    atr: 2,
    prevRsi: 52,
    prevHist: 0.4,
    prevEma20: 99,
    prevEma50: 94,
    prevEma200: 89,
    currentClose: 104,
    volume: 1000,
    prevVolume: 900,
    volumeSma20: 950,
    high: 105,
    low: 101,
    open: 102,
    atrAvg20: 1.8,
  };
}

function snapshot1h(): CacheSnapshot {
  const ind = indicator("BTC");
  return {
    lastUpdated: "2026-06-17T10:00:00.000Z",
    refreshing: false,
    lastFetchFailed: false,
    stockSymbols: [],
    cryptoSymbols: ["BTC"],
    data: new Map([
      [
        "BTC",
        {
          indicators: ind,
          quote: { symbol: "BTC", price: 104, change: 2, changePct: 1.96, changeUp: true, volume: 1000 },
          derived: {
            priceAboveEma20: true,
            ema20Slope: 1,
            ema20PctDist: 4,
            histChange: 0.1,
            rsiChange: 3,
            volumeChangePct: 11.11,
            relativeVolume: null,
            volumeExpanding: true,
            volumeAboveAverage: null,
            atrPct: 1.923,
            distanceFromEmaInAtr: 2,
            candleRangeInAtr: 2,
          },
        },
      ],
    ]),
  };
}

function snapshot1d(): CacheSnapshot1d {
  const ind = indicator("BTC");
  return {
    lastUpdated: "2026-06-17T10:00:00.000Z",
    refreshing: false,
    lastFetchFailed: false,
    stockSymbols: [],
    cryptoSymbols: ["BTC"],
    data: new Map([
      [
        "BTC",
        {
          indicators: ind,
          quote: { symbol: "BTC", price: 104, change: 2, changePct: 1.96, changeUp: true, volume: 1000 },
          derived: {
            priceAboveEma50: true,
            priceAboveEma200: true,
            ema50AboveEma200: true,
            ema50Slope: 1,
            ema200Slope: 1,
          },
        },
      ],
    ]),
  };
}

async function runDashboardChecks(): Promise<void> {
  console.log("\n=== dashboard pipeline service ===");
  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  const oldOpenAIEnabled = process.env.OPENAI_ENABLED;
  const oldOpenAIRegimeEnabled = process.env.OPENAI_REGIME_ENABLED;
  const oldOpenAIStrategyAgentsEnabled = process.env.OPENAI_STRATEGY_AGENTS_ENABLED;
  delete process.env.OPENAI_API_KEY;
  process.env.OPENAI_ENABLED = "false";
  process.env.OPENAI_REGIME_ENABLED = "false";
  process.env.OPENAI_STRATEGY_AGENTS_ENABLED = "false";
  const waits: number[] = [];
  let confluenceSawA6 = false;
  let openAIAgentCalled = false;
  const result = await runDashboardRefreshPipeline({
    cache: {
      async forceRefresh() {},
      read: snapshot1h,
    },
    cache1d: {
      async forceRefresh() {},
      read: snapshot1d,
    },
    writeMemCache: false,
    sleepMs: async (ms) => {
      waits.push(ms);
    },
    now: () => new Date("2026-06-17T10:00:05.000Z"),
    nowMs: (() => {
      let value = 1_000;
      return () => {
        value += 25;
        return value;
      };
    })(),
    runRegimeDetectorFn: async () => {
      openAIAgentCalled = true;
      throw new Error("OpenAI regime detector should be skipped");
    },
    runMomentumScoutFn: async () => {
      openAIAgentCalled = true;
      throw new Error("OpenAI momentum scout should be skipped");
    },
    runBreakoutWatcherFn: async () => {
      openAIAgentCalled = true;
      throw new Error("OpenAI breakout watcher should be skipped");
    },
    runTrendFollowerFn: async () => {
      openAIAgentCalled = true;
      throw new Error("OpenAI trend follower should be skipped");
    },
    runVolatilityArbiterFn: async () => {
      openAIAgentCalled = true;
      throw new Error("OpenAI volatility arbiter should be skipped");
    },
    runMeanReversionFn: async () => {
      openAIAgentCalled = true;
      throw new Error("OpenAI mean reversion should be skipped");
    },
    runConfluenceEngineFn: async (signals, regimeMap) => {
      confluenceSawA6 = signals.some((signal) => signal.agent === "Regime Detector");
      eq("confluence receives A6 regime context", regimeMap?.BTC?.regime, "TREND_UP");
      return [
        {
          symbol: "BTC",
          verdict: "aligned_bullish",
          weightedScore: 3,
          narrative: "test narrative",
          tags: [],
          agentVotes: [],
          gateMet: true,
          hasHardConflict: false,
          regime: "TREND_UP",
          regimeReliability: 0.9,
          regimeBlocked: false,
          regimeBlockReason: null,
        },
      ];
    },
  });

  assert("dashboard service returns success", result.ok);
  if (result.ok) {
    eq("dashboard response contract success", result.body.success, true);
    assert("dashboard response includes durationMs", typeof result.body.durationMs === "number");
    eq("dashboard preserves A6 ordering after A1-A5", result.body.agentResults.map((a) => a.id), ["A1", "A2", "A3", "A4", "A5", "A6"]);
    eq("dashboard response includes regime map", result.body.regimeMap.BTC.regime, "TREND_UP");
    eq("dashboard reports regime OpenAI skipped", (result.body.openai?.regime as { reason?: string }).reason, "openai_disabled");
    eq("dashboard reports strategy OpenAI skipped", (result.body.openai?.strategyAgents as { reason?: string }).reason, "openai_disabled");
  }
  eq("dashboard waits before 1D refresh", waits, [15_000]);
  eq("confluence voting excludes A6", confluenceSawA6, false);
  eq("dashboard disabled env avoids OpenAI agent calls", openAIAgentCalled, false);
  if (oldOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldOpenAIKey;
  if (oldOpenAIEnabled === undefined) delete process.env.OPENAI_ENABLED;
  else process.env.OPENAI_ENABLED = oldOpenAIEnabled;
  if (oldOpenAIRegimeEnabled === undefined) delete process.env.OPENAI_REGIME_ENABLED;
  else process.env.OPENAI_REGIME_ENABLED = oldOpenAIRegimeEnabled;
  if (oldOpenAIStrategyAgentsEnabled === undefined) delete process.env.OPENAI_STRATEGY_AGENTS_ENABLED;
  else process.env.OPENAI_STRATEGY_AGENTS_ENABLED = oldOpenAIStrategyAgentsEnabled;
}

async function runRegimeChecks(): Promise<void> {
  console.log("\n=== regime pipeline service ===");
  resetRegimeRefreshPipelineCacheForSmoke();
  const waits: number[] = [];
  const result = await runRegimeRefreshPipeline({
    symbol: "BTC",
    sleepMs: async (ms) => {
      waits.push(ms);
    },
    now: () => new Date("2026-06-17T10:00:00.000Z"),
    fetchIndicatorsFn: async () => new Map([["BTC", indicator("BTC")]]),
    fetchIndicators1dFn: async () => new Map([["BTC", indicator("BTC")]]),
    fetchQuotesFn: async () =>
      new Map([["BTC", { symbol: "BTC", price: 104, change: 2, changePct: 1.96, changeUp: true, volume: 1000 }]]),
    runRegimeDetectorFn: async (_snapshot, _snapshot1d, symbols) => [
      {
        symbol: symbols?.[0] ?? "BTC",
        agent: "Regime Detector",
        type: "watch",
        reason: "test regime",
        confidence: "high",
        regime: "TREND_UP",
        reliability: 0.9,
        emaContext: { ema20Slope: "rising", ema50Above200: true },
        volContext: { atrPct: 1.923, atrRegime: "normal" },
      },
    ],
  });

  assert("regime service returns success", result.ok);
  if (result.ok) {
    eq("regime response contract success", result.body.success, true);
    eq("regime response symbol", result.body.symbol, "BTC");
    eq("regime response tradePermission", result.body.tradePermission, "ALLOW_UP_ONLY");
    assert("regime response includes updatedAt", typeof result.body.updatedAt === "string");
  }
  eq("regime cold path waits before 1D fetch", waits, [16_000]);
}

async function runMarketIngestChecks(): Promise<void> {
  console.log("\n=== market ingest pipeline service ===");
  const store = new InMemoryBarStore();
  const bars: Bar[] = [
    {
      symbol: "BTC-USD",
      exchange: "COINBASE",
      timeframe: "1h",
      ts: "2026-06-17T10:00:00.000Z",
      open: 100,
      high: 105,
      low: 99,
      close: 104,
      volume: 10,
      tradeCount: null,
    },
    {
      symbol: "BTC-USD",
      exchange: "COINBASE",
      timeframe: "1h",
      ts: "2026-06-17T11:00:00.000Z",
      open: 104,
      high: 106,
      low: 103,
      close: 105,
      volume: 8,
      tradeCount: null,
    },
    {
      symbol: "BTC-USD",
      exchange: "COINBASE",
      timeframe: "1h",
      ts: "2026-06-17T12:00:00.000Z",
      open: 105,
      high: 107,
      low: 104,
      close: 106,
      volume: 9,
      tradeCount: null,
    },
  ];

  const result = await runMarketIngestLatestPipeline({
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
    source: "coinbase",
    closedBarsOnly: true,
    startTs: "2026-06-17T10:00:00.000Z",
    endTs: "2026-06-17T13:00:00.000Z",
    barStore: store,
    now: () => new Date("2026-06-17T12:30:00.000Z"),
    fetchBarsFn: async () => bars,
  });

  eq("market ingest fetched all source bars", result.fetchedBars, 3);
  eq("market ingest inserts only closed bars", result.insertedBars, 2);
  eq("market ingest counts skipped open/duplicate bars", result.skippedBars, 1);
  eq("market ingest latest closed ts", result.latestTs, "2026-06-17T11:00:00.000Z");

  const duplicate = await runMarketIngestLatestPipeline({
    symbols: ["BTC-USD"],
    exchange: "COINBASE",
    timeframe: "1h",
    source: "coinbase",
    closedBarsOnly: true,
    startTs: "2026-06-17T10:00:00.000Z",
    endTs: "2026-06-17T13:00:00.000Z",
    barStore: store,
    now: () => new Date("2026-06-17T12:30:00.000Z"),
    fetchBarsFn: async () => bars,
  });
  eq("market ingest is idempotent", duplicate.insertedBars, 0);
}

async function runSnapshotChecks(): Promise<void> {
  console.log("\n=== dashboard snapshot pipeline service ===");
  const skipped = await writeDashboardSnapshot({
    snapshotType: "dashboard",
    payload: { ok: true },
  });
  eq("snapshot write skips when no store provided", skipped.skipped, true);

  const written = await writeDashboardSnapshot({
    store: {
      async insertSnapshot(input) {
        return {
          id: 1,
          publicId: "snap_1",
          snapshotType: input.snapshotType,
          symbol: input.symbol ?? null,
          timeframe: input.timeframe ?? null,
          payload: input.payload,
          sourceJobId: input.sourceJobId ?? null,
          generatedAt: "2026-06-17T10:00:00.000Z",
          expiresAt: null,
          createdAt: "2026-06-17T10:00:00.000Z",
        };
      },
    },
    snapshotType: "dashboard",
    symbol: "BTC-USD",
    timeframe: "1h",
    payload: { ok: true },
  });
  eq("snapshot write uses provided store", written.skipped, false);
}

function runFeatureBridgeChecks(): void {
  console.log("\n=== persisted feature bridge ===");
  const feature: FeatureSnapshot = {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: "2026-06-17T11:00:00.000Z",
    close: 104,
    rsi14: 55,
    macd: 1,
    macdSignal: 0.5,
    macdHist: 0.5,
    ema20: 100,
    ema20Slope: 1,
    atr14: 2,
    atrPct: 1.923,
    bbUpper: 110,
    bbMiddle: 100,
    bbLower: 90,
    featureVersion: "features.test.v1",
  };
  const bridged = adaptFeatureSnapshotsToRegimeDetectorInput({
    features1h: [feature],
    now: () => new Date("2026-06-17T12:00:00.000Z"),
  });
  eq("feature bridge creates cache snapshot key", bridged.snapshot.data.has("BTC-USD"), true);
  eq("feature bridge documents 1D absence as failed context", bridged.snapshot1d.lastFetchFailed, true);
}

function readText(repoPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), repoPath), "utf8");
}

function listFiles(dir: string): string[] {
  const abs = path.join(process.cwd(), dir);
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  });
}

async function runStaticChecks(): Promise<void> {
  console.log("\n=== static framework boundary checks ===");
  const pipelineFiles = listFiles("lib/pipeline").filter((file) => file.endsWith(".ts"));
  for (const file of pipelineFiles) {
    const text = readText(file);
    assert(`${file} has no NextRequest import`, !text.includes("NextRequest"));
    assert(`${file} has no NextResponse import`, !text.includes("NextResponse"));
    assert(`${file} does not import route files`, !text.includes("app/api"));
    assert(`${file} does not fetch API routes`, !text.includes("fetch('/api") && !text.includes('fetch("/api'));
  }

  for (const file of ["app/api/cache/refresh/route.ts", "app/api/regime/refresh/route.ts"]) {
    const text = readText(file);
    assert(`${file} does not fetch another API route`, !text.includes("fetch('/api") && !text.includes('fetch("/api'));
  }

  const marketIngestText = readText("lib/pipeline/marketIngestPipeline.ts").toLowerCase();
  assert("market ingest does not import taapi", !marketIngestText.includes("taapi"));
  assert("market ingest names closed bar behavior", marketIngestText.includes("closedbar"));

  const forbiddenFiles = [
    "lib/jobs/scheduler.ts",
    "scripts/jobScheduler.ts",
    "app/api/jobs/worker/route.ts",
    "app/api/jobs/scheduler/route.ts",
  ];
  for (const file of forbiddenFiles) {
    assert(`no scheduler/public worker route added: ${file}`, !fs.existsSync(path.join(process.cwd(), file)));
  }

  assertNoLiveExecutionJobTypes();
  assert("no live execution job types introduced", JOB_TYPES.every((jobType) => !FORBIDDEN_LIVE_JOB_TYPES.includes(jobType as never)));

  for (const file of pipelineFiles) {
    await import(pathToFileURL(path.join(process.cwd(), file)).href);
  }
  assert("pipeline modules import without HTTP objects", true);
}

async function main(): Promise<void> {
  await runDashboardChecks();
  await runRegimeChecks();
  await runMarketIngestChecks();
  await runSnapshotChecks();
  runFeatureBridgeChecks();
  await runStaticChecks();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
