import type { AssetIndicatorConfig } from "@/config/indicators";
import type { RegimeLabel, RegimeSignal } from "@/lib/agents/regimeDetector";
import type { CacheSnapshot } from "@/lib/indicatorCache";
import type { CacheSnapshot1d } from "@/lib/indicatorCache1d";
import type { ConfluenceResult, RegimeMap } from "@/lib/confluence/confluenceEngine";
import type {
  DashboardSnapshotRecord,
  DashboardSnapshotType,
  InsertDashboardSnapshotInput,
} from "@/lib/jobs/dashboardSnapshotStore";
import type { AssetType, PolygonQuote } from "@/lib/polygon";
import type { Bar, Exchange, FeatureSnapshot, Timeframe } from "@/lib/quant/types";
import type { AgentResult, DashboardStats, LiveActivityEntry, Signal } from "@/lib/signals";
import type { BarStore } from "@/lib/storage/interfaces";
import type { IndicatorValues } from "@/lib/taapi";
import type { DataQualityIssue, DataQualityReport } from "@/lib/dataQuality/types";
import type { VolumePolicy } from "@/lib/dataQuality/barQuality";
import type { MarketIdentity } from "@/lib/dataQuality/marketIdentity";
import type { SourceLineage } from "@/lib/market/types";

export type SleepFn = (ms: number) => Promise<void>;
export type NowFn = () => Date;
export type NowMsFn = () => number;

/**
 * "taapi_live_cache" (default) preserves the legacy behavior used by the
 * debug-only /api/cache/refresh route. "persisted_feature_snapshots" is the
 * production dashboard.snapshot job path (P10B) — no TAAPI/Yahoo mixed-source
 * warnings, since the dashboard reads the same canonical feature_snapshots
 * rows that regime.compute and strategies.evaluate read.
 */
export type DashboardDataSource = "taapi_live_cache" | "persisted_feature_snapshots";

export interface PipelineErrorBody {
  success: false;
  error: string;
  detail?: string;
}

export interface PipelineFailure {
  ok: false;
  status: number;
  body: PipelineErrorBody;
}

export interface PipelineSuccess<TBody> {
  ok: true;
  status: 200;
  body: TBody;
}

export type PipelineResult<TBody> = PipelineSuccess<TBody> | PipelineFailure;

export interface CacheAdapter<TSnapshot> {
  forceRefresh(): Promise<void>;
  read(): TSnapshot;
}

export interface DashboardRegimeContext {
  regime: RegimeLabel;
  reliability: number;
  emaContext: RegimeSignal["emaContext"];
  volContext: RegimeSignal["volContext"];
}

export interface DashboardRefreshPayload {
  agentResults: AgentResult[];
  confluence: ConfluenceResult[];
  regimeMap: Record<string, DashboardRegimeContext>;
  stats: DashboardStats;
  activity: LiveActivityEntry[];
  generatedAt: string;
  indicators: Record<string, IndicatorValues>;
  derived: Record<string, unknown>;
  dataQuality: {
    severity: DataQualityReport["severity"];
    issues: DataQualityIssue[];
    symbols: Record<string, {
      market: MarketIdentity;
      barQuality: DataQualityReport | null;
      featureQuality: DataQualityReport | null;
      freshness: Record<string, unknown>;
    }>;
  };
  marketContext: {
    canonicalScheduled: {
      market: MarketIdentity;
      sourceLineage: SourceLineage;
      trustedForScheduledJobs: true;
    };
    dashboardDisplay: {
      market: MarketIdentity;
      providers: string[];
      sourceLineage: SourceLineage;
      trustedForScheduledJobs: false;
      warning: string;
    };
  };
  openai?: Record<string, unknown>;
}

export type DashboardRefreshResponseBody = {
  success: true;
  durationMs: number;
} & DashboardRefreshPayload;

export interface DashboardRefreshPipelineInput {
  cache?: CacheAdapter<CacheSnapshot>;
  cache1d?: CacheAdapter<CacheSnapshot1d>;
  waitBefore1dMs?: number;
  sleepMs?: SleepFn;
  now?: NowFn;
  nowMs?: NowMsFn;
  writeMemCache?: boolean;
  /** Defaults to "[cache/refresh]" to preserve the legacy debug-route log prefix. */
  logPrefix?: string;
  /** Defaults to "taapi_live_cache" to preserve legacy debug-route behavior. */
  dataSource?: DashboardDataSource;
  runRegimeDetectorFn?: (
    snapshot: CacheSnapshot,
    snapshot1d: CacheSnapshot1d,
    symbols?: string[],
  ) => Promise<RegimeSignal[]>;
  runMomentumScoutFn?: (snapshot: CacheSnapshot, symbols?: string[]) => Promise<Signal[]>;
  runBreakoutWatcherFn?: (snapshot: CacheSnapshot, timeframe?: string) => Promise<Signal[]>;
  runTrendFollowerFn?: (snapshot: CacheSnapshot1d, timeframe?: string) => Promise<Signal[]>;
  runVolatilityArbiterFn?: (snapshot: CacheSnapshot, timeframe?: string) => Promise<Signal[]>;
  runMeanReversionFn?: (snapshot: CacheSnapshot) => Promise<Signal[]>;
  runConfluenceEngineFn?: (signals: Signal[], regimeMap?: RegimeMap) => Promise<ConfluenceResult[]>;
}

export type DashboardRefreshPipelineResult = PipelineResult<DashboardRefreshResponseBody>;

export type RegimeAsset = { symbol: string; type: AssetType };

export interface RegimeRefreshSuccessBody {
  success: true;
  symbol: string;
  regime: RegimeLabel;
  reliability: number;
  directionalBias: string;
  tradePermission: string;
  edgeMultiplier: number;
  sizeMultiplier: number;
  emaContext: RegimeSignal["emaContext"];
  volContext: RegimeSignal["volContext"];
  reason: string;
  updatedAt: string;
}

export interface RegimeRefreshPipelineInput {
  symbol?: string;
  sleepMs?: SleepFn;
  now?: NowFn;
  nowMs?: NowMsFn;
  waitBefore1dMs?: number;
  fetchIndicatorsFn?: (
    assets: RegimeAsset[],
    indicatorConfig: AssetIndicatorConfig[],
  ) => Promise<Map<string, IndicatorValues>>;
  fetchIndicators1dFn?: (
    assets: RegimeAsset[],
    indicatorConfig: AssetIndicatorConfig[],
  ) => Promise<Map<string, IndicatorValues>>;
  fetchQuotesFn?: (assets: RegimeAsset[]) => Promise<Map<string, PolygonQuote>>;
  runRegimeDetectorFn?: (
    snapshot: CacheSnapshot,
    snapshot1d: CacheSnapshot1d,
    symbols?: string[],
  ) => Promise<RegimeSignal[]>;
}

export type RegimeRefreshPipelineResult = PipelineResult<RegimeRefreshSuccessBody>;

export interface FeatureSnapshotRegimeBridgeInput {
  features1h: FeatureSnapshot[];
  features1d?: FeatureSnapshot[];
  now?: NowFn;
}

export interface FeatureSnapshotRegimeBridgeOutput {
  snapshot: CacheSnapshot;
  snapshot1d: CacheSnapshot1d;
}

export type MarketIngestSource = "coinbase" | "polygon";

export interface MarketIngestLatestPipelineInput {
  symbols: string[];
  exchange: Exchange;
  timeframe: Extract<Timeframe, "1h" | "1d">;
  source: MarketIngestSource;
  closedBarsOnly: true;
  startTs: string;
  endTs?: string;
  barStore: Pick<BarStore, "insertMany">;
  dataSourceVersion?: string;
  volumePolicy?: VolumePolicy;
  now?: NowFn;
  fetchBarsFn?: (input: {
    symbol: string;
    exchange: Exchange;
    timeframe: Extract<Timeframe, "1h" | "1d">;
    source: MarketIngestSource;
    startTs: string;
    endTs: string;
  }) => Promise<Bar[]>;
}

export interface MarketIngestLatestPipelineResult {
  success: true;
  source: MarketIngestSource;
  exchange: Exchange;
  timeframe: Extract<Timeframe, "1h" | "1d">;
  closedBarsOnly: true;
  fetchedBars: number;
  insertedBars: number;
  skippedBars: number;
  latestTs: string | null;
  symbols: Record<string, {
    fetchedBars: number;
    insertedBars: number;
    skippedBars: number;
    latestTs: string | null;
    dataQuality?: DataQualityReport & {
      checkedBars: number;
      passedBars: number;
      warnedBars: number;
      blockedBars: number;
    };
  }>;
  dataQuality: DataQualityReport & {
    checkedBars: number;
    passedBars: number;
    warnedBars: number;
    blockedBars: number;
  };
}

export interface DashboardSnapshotWriteInput extends InsertDashboardSnapshotInput {
  store?: {
    insertSnapshot(input: InsertDashboardSnapshotInput): Promise<DashboardSnapshotRecord>;
  };
  snapshotType: DashboardSnapshotType;
}

export type DashboardSnapshotWriteResult =
  | {
      success: true;
      skipped: false;
      snapshot: DashboardSnapshotRecord;
    }
  | {
      success: true;
      skipped: true;
      reason: string;
    };
