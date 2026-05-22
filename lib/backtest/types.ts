import type {
  Bar,
  Exchange,
  FeatureSnapshot,
  RegimeContext,
  RegimeLabel,
  StrategySignal,
  Timeframe,
} from "@/lib/quant/types";
import type { StrategyInput } from "@/lib/strategies/types";

export type BacktestAssetType = "CRYPTO" | "EQUITY" | "ETF" | "UNKNOWN";

export interface BacktestInstrumentContext {
  symbol: string;
  exchange: Exchange;
  assetType?: BacktestAssetType;
  dataSource?: string;
}

export interface StrategyRouter {
  id: string;
  version: string;
  evaluate(input: StrategyInput): StrategySignal | null;
}

export interface BacktestConfig {
  symbol: string;
  exchange: Exchange;
  assetType?: BacktestAssetType;
  dataSource?: string;
  timeframe: Timeframe;
  strategyId: string;
  featureVersion: string;
  startTs: string;
  endTs: string;

  initialCapital: number;
  riskPerTradePct: number;
  maxPositionPct: number;
  maxConcurrentPositions: 1;
  allowShorts?: boolean;

  feeBps: number;
  slippageBps: number;

  defaultRewardRisk?: number;
  closeOpenPositionAtEnd: boolean;

  enterOnNextBarOpen: true;
  sameBarStopFirst: true;
}

export interface BacktestInput {
  config: BacktestConfig;
  bars: Bar[];
  features: FeatureSnapshot[];
  dailyFeatures?: FeatureSnapshot[];
  regimes?: RegimeContext[];
  strategyRouter?: StrategyRouter;
}

export type TradeExitReason =
  | "stop_loss"
  | "take_profit"
  | "end_of_test"
  | "signal_exit"
  | "no_exit";

export interface SimulatedTrade {
  symbol: string;
  exchange: Exchange;
  direction: "long" | "short";
  strategyId: string;
  strategyVersion: string;
  featureVersion: string;

  signalTs: string;
  entryTs: string;
  entryPrice: number;
  exitTs: string | null;
  exitPrice: number | null;
  quantity: number;

  stopLoss: number | null;
  takeProfit: number | null;

  grossPnl: number;
  fees: number;
  slippageCost: number;
  pnl: number;
  pnlPct: number;

  reasonEntered: string;
  reasonExited: TradeExitReason;
  holdBars: number;
  holdHours: number;

  regimeAtEntry: RegimeLabel | "UNKNOWN";
  entryHourUtc: number;

  sourceSignal: StrategySignal;
}

export interface EquityPoint {
  ts: string;
  equity: number;
  drawdownPct: number;
  openPositionMarketValue: number;
}

export interface BacktestMetrics {
  initialCapital: number;
  endingEquity: number;
  totalReturnPct: number;
  cagrPct: number | null;
  maxDrawdownPct: number;

  numberOfTrades: number;
  winRatePct: number | null;
  averageWinner: number | null;
  averageLoser: number | null;
  profitFactor: number | null;
  expectancyPerTrade: number | null;

  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  maxWinningStreak: number;
  maxLosingStreak: number;
  exposurePct: number | null;
  avgTradeDurationBars: number | null;
  avgTradeDurationMs: number | null;
  medianTradeDurationBars: number | null;
  medianTradeDurationMs: number | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  profitPerBar: number | null;
  returnToDrawdown: number | null;
  tradeFrequency: number | null;

  sharpeApprox: number | null;
  sortinoApprox: number | null;

  exposureTimePct: number;
  averageHoldHours: number | null;
  bestTradePnl: number | null;
  worstTradePnl: number | null;
  maxConsecutiveLosses: number;

  regimePerformance: Record<string, {
    trades: number;
    totalPnl: number;
    winRatePct: number | null;
    profitFactor: number | null;
  }>;

  timeOfDayPerformance: Record<string, {
    trades: number;
    totalPnl: number;
    winRatePct: number | null;
  }>;

  notes: string[];
}

export interface BacktestResult {
  config: BacktestConfig;
  strategyVersion: string;
  trades: SimulatedTrade[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
}

export interface BacktestRunRow {
  id: number;
  publicId: string;
  strategyId: string;
  strategyVersion: string;
  symbol: string;
  exchange: Exchange;
  timeframe: Timeframe;
  startTs: string;
  endTs: string;
  config: BacktestConfig;
  metrics: BacktestMetrics;
  createdAt: string;
}

export interface BacktestTradeRow {
  id: number;
  backtestRunId: number;
  symbol: string;
  exchange: Exchange;
  direction: "long" | "short";
  entryTs: string;
  entryPrice: number;
  exitTs: string | null;
  exitPrice: number | null;
  quantity: number;
  pnl: number | null;
  pnlPct: number | null;
  reasonEntered: string | null;
  reasonExited: string | null;
  regimeAtEntry: RegimeLabel | null;
  insertedAt: string;
}

