// lib/dashboard/dashboardArchitecture.ts
// Typed static data for the architecture dashboard.
// All values here are placeholders — replace with live API calls as layers mature.

export type StatusState =
  | "active"
  | "in_progress"
  | "pending"
  | "disabled"
  | "planned"
  | "validated"
  | "needs_validation";

export type PipelineStage = {
  name: string;
  status: StatusState;
  purpose: string;
  inputs: string[];
  outputs: string[];
  maturity: string;
};

export type SystemStatusCard = {
  label: string;
  status: StatusState;
  description: string;
};

export type AgentOverview = {
  id: string;
  name: string;
  status: StatusState;
  description: string;
  purpose: string;
};

export type RegimeOverview = {
  regime: string;
  description: string;
  strategyImplication: string;
  researchStatus: string;
};

export type StrategyResearchCandidate = {
  name: string;
  currentRead: string;
  promisingIn: string[];
  investigate: string[];
};

export type AssetCoverage = {
  symbol: string;
  dataCoverage: StatusState;
  featureCoverage: StatusState;
  regimeSnapshots: StatusState;
  strategyResearch: StatusState;
  backtestReadiness: StatusState;
};

export type DataHealthMetric = {
  label: string;
  value: string;
  status: StatusState;
};

export type ExecutionRequirement = {
  label: string;
  status: StatusState;
};

export type SystemEvent = {
  timestamp: string;
  label: string;
  description: string;
  severity: "info" | "warning" | "success" | "error";
};

// ── Pipeline stages ──────────────────────────────────────────────────────────

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    name: "Market Data",
    status: "active",
    purpose: "Collect raw market candles for supported assets.",
    inputs: ["Exchange / market API data"],
    outputs: ["Timestamped OHLCV candles"],
    maturity: "Active",
  },
  {
    name: "OHLCV Storage",
    status: "active",
    purpose: "Persist normalized candle data for research, features, and backtesting.",
    inputs: ["Raw market candles"],
    outputs: ["Stored 1H / 1D OHLCV bars"],
    maturity: "Active",
  },
  {
    name: "Feature Computation",
    status: "in_progress",
    purpose: "Compute technical and statistical indicators used by agents and strategy research.",
    inputs: ["OHLCV candles"],
    outputs: ["RSI", "MACD histogram", "EMA values", "ATR", "Relative volume", "Bollinger Band width", "Candle range vs ATR"],
    maturity: "Active / In Progress",
  },
  {
    name: "A6 Regime Detector",
    status: "active",
    purpose: "Classifies the current market environment before strategy evaluation.",
    inputs: ["1H EMA20 slope", "1D EMA50 / EMA200", "ATR %", "Relative volume", "Candle range vs ATR"],
    outputs: ["TREND_UP", "TREND_DOWN", "LOW_VOL", "HIGH_VOL", "CHOP", "NEWS_SHOCK", "Reliability score", "Strategy gating recommendations"],
    maturity: "Active",
  },
  {
    name: "Strategy Candidates",
    status: "in_progress",
    purpose: "Evaluate strategy behavior across market regimes.",
    inputs: ["Computed features", "A6 regime context", "Historical bars"],
    outputs: ["Momentum continuation signals", "Breakout expansion signals", "Trend pullback signals", "Mean reversion signals"],
    maturity: "Active Research",
  },
  {
    name: "Router / Portfolio Research",
    status: "in_progress",
    purpose: "Compare strategy routing against static strategies and portfolio blends.",
    inputs: ["Strategy backtest results", "Regime snapshots", "Asset coverage data"],
    outputs: ["Router performance", "Best static strategy comparison", "Equal-weight portfolio comparison", "Regime-weighted portfolio comparison", "Return-to-drawdown metrics"],
    maturity: "Active Research",
  },
  {
    name: "Risk Engine",
    status: "pending",
    purpose: "Approve, block, or resize future strategy decisions before execution.",
    inputs: ["Strategy signal", "Regime context", "Account equity", "Open positions", "Recent PnL", "Risk configuration"],
    outputs: ["Approved / blocked decision", "Size multiplier", "Max risk USD", "Position size", "Stop loss", "Take profit", "Blocked-by reasons"],
    maturity: "Pending — Not Started",
  },
  {
    name: "Execution Layer",
    status: "disabled",
    purpose: "Future controlled execution layer.",
    inputs: ["Approved risk decision", "Validated strategy signal"],
    outputs: ["Order routing", "Position management", "Fill reporting"],
    maturity: "Disabled until risk engine complete",
  },
];

// ── System status cards ───────────────────────────────────────────────────────

export const SYSTEM_STATUS: SystemStatusCard[] = [
  {
    label: "Research Mode",
    status: "active",
    description: "Platform is currently focused on research, validation, and architecture hardening.",
  },
  {
    label: "Execution",
    status: "disabled",
    description: "Live execution is intentionally blocked until risk controls exist.",
  },
  {
    label: "Regime Layer",
    status: "active",
    description: "A6 regime detector is integrated into the research pipeline.",
  },
  {
    label: "Multi-Asset Research",
    status: "in_progress",
    description: "BTC, ETH, SOL, LINK, and AVAX are part of the initial crypto research set.",
  },
  {
    label: "Risk Engine",
    status: "pending",
    description: "Required before any live or paper execution layer should be trusted.",
  },
  {
    label: "Router Validation",
    status: "in_progress",
    description: "Strategy routing is being compared against static and portfolio baselines.",
  },
];

// ── Agents ────────────────────────────────────────────────────────────────────

export const AGENTS: AgentOverview[] = [
  {
    id: "A1",
    name: "Momentum Scout",
    status: "active",
    description: "Tracks RSI, MACD histogram, EMA20, ATR, and volume behavior.",
    purpose: "Detects directional momentum and continuation conditions.",
  },
  {
    id: "A2",
    name: "Breakout Watcher",
    status: "active",
    description: "Detects Bollinger Band expansion and breakout conditions.",
    purpose: "Identifies potential volatility expansion and breakout setups.",
  },
  {
    id: "A3",
    name: "Trend Follower",
    status: "active",
    description: "Evaluates macro trend structure using EMA50 / EMA200.",
    purpose: "Determines broader trend alignment and directional bias.",
  },
  {
    id: "A4",
    name: "Volatility Arbiter",
    status: "active",
    description: "Measures volatility expansion, compression, and shock risk.",
    purpose: "Helps distinguish normal movement from high-volatility or news-shock environments.",
  },
  {
    id: "A5",
    name: "Confluence Engine",
    status: "active",
    description: "Combines agent outputs into a unified directional signal.",
    purpose: "Aggregates agent-level signals into a broader system-level interpretation.",
  },
  {
    id: "A6",
    name: "Regime Detector",
    status: "active",
    description: "Classifies market environment and produces regime reliability plus gating recommendations.",
    purpose: "Runs before strategy routing and determines which strategies should be allowed, reduced, or blocked.",
  },
];

// ── Regimes ───────────────────────────────────────────────────────────────────

export const REGIMES: RegimeOverview[] = [
  {
    regime: "TREND_UP",
    description: "Market structure is directionally bullish with supportive trend alignment.",
    strategyImplication: "Momentum continuation and breakout expansion may be more favorable.",
    researchStatus: "Supported by current P5 strategy research.",
  },
  {
    regime: "TREND_DOWN",
    description: "Market structure is directionally bearish or deteriorating.",
    strategyImplication: "Long-biased strategies should be filtered carefully. Mean reversion should be restricted.",
    researchStatus: "Requires tighter survival and confidence filters.",
  },
  {
    regime: "LOW_VOL",
    description: "Compressed volatility environment with limited directional expansion.",
    strategyImplication: "Breakout strategies should be blocked unless expansion is confirmed. Mean reversion may be considered with additional confirmation.",
    researchStatus: "Needs tighter gating.",
  },
  {
    regime: "HIGH_VOL",
    description: "Elevated volatility environment with larger candle ranges and stronger risk.",
    strategyImplication: "Position sizing and risk controls become more important. Execution should be restricted without risk engine support.",
    researchStatus: "Requires risk-layer integration before live use.",
  },
  {
    regime: "CHOP",
    description: "Unclear directional structure with noisy or mean-reverting behavior.",
    strategyImplication: "Trend-following and breakout strategies may underperform. Mean reversion may be considered with strict confirmation.",
    researchStatus: "Needs further validation.",
  },
  {
    regime: "NEWS_SHOCK",
    description: "Abnormal volume or candle behavior suggests market shock conditions.",
    strategyImplication: "Trading should likely be blocked or heavily reduced.",
    researchStatus: "Should be treated as high-risk until further validation.",
  },
];

// ── Strategy research ─────────────────────────────────────────────────────────

export const STRATEGY_RESEARCH: StrategyResearchCandidate[] = [
  {
    name: "Momentum Continuation",
    currentRead: "Promising in TREND_UP, TREND_DOWN survival, and LOW_VOL survival.",
    promisingIn: ["TREND_UP", "TREND_DOWN survival", "LOW_VOL survival"],
    investigate: [
      "Better entry filter",
      "Reduce bad low-confidence trades",
      "Add regime confidence threshold",
    ],
  },
  {
    name: "Breakout Expansion",
    currentRead: "Most promising in TREND_UP environments.",
    promisingIn: ["TREND_UP"],
    investigate: [
      "Only allow in TREND_UP or strong volatility expansion",
      "Block in LOW_VOL and TREND_DOWN unless confirmed",
    ],
  },
  {
    name: "Trend Pullback",
    currentRead: "Weak overall but high profit factor in TREND_UP.",
    promisingIn: ["TREND_UP (high PF)"],
    investigate: [
      "Fewer trades, higher-confidence entries only",
      "Stronger macro trend filter",
    ],
  },
  {
    name: "Mean Reversion",
    currentRead: "Needs tighter gating across all regimes.",
    promisingIn: ["LOW_VOL", "CHOP (with confirmation)"],
    investigate: [
      "Block during TREND_DOWN",
      "Allow only in LOW_VOL / CHOP",
      "Require oversold confirmation",
    ],
  },
];

// ── Asset coverage ────────────────────────────────────────────────────────────

export const ASSET_COVERAGE: AssetCoverage[] = [
  {
    symbol: "BTC-USD",
    dataCoverage: "active",
    featureCoverage: "active",
    regimeSnapshots: "active",
    strategyResearch: "active",
    backtestReadiness: "active",
  },
  {
    symbol: "ETH-USD",
    dataCoverage: "active",
    featureCoverage: "in_progress",
    regimeSnapshots: "in_progress",
    strategyResearch: "in_progress",
    backtestReadiness: "needs_validation",
  },
  {
    symbol: "SOL-USD",
    dataCoverage: "active",
    featureCoverage: "in_progress",
    regimeSnapshots: "in_progress",
    strategyResearch: "in_progress",
    backtestReadiness: "needs_validation",
  },
  {
    symbol: "LINK-USD",
    dataCoverage: "active",
    featureCoverage: "in_progress",
    regimeSnapshots: "in_progress",
    strategyResearch: "in_progress",
    backtestReadiness: "needs_validation",
  },
  {
    symbol: "AVAX-USD",
    dataCoverage: "active",
    featureCoverage: "in_progress",
    regimeSnapshots: "in_progress",
    strategyResearch: "in_progress",
    backtestReadiness: "needs_validation",
  },
];

// ── Data health ───────────────────────────────────────────────────────────────

export const DATA_HEALTH: DataHealthMetric[] = [
  { label: "Last Candle Received",       value: "—",          status: "active"      },
  { label: "1H Coverage",                value: "~2yr",        status: "active"      },
  { label: "1D Rollup Status",           value: "Active",      status: "active"      },
  { label: "Missing Bar Count",          value: "—",          status: "in_progress" },
  { label: "Feature Freshness",          value: "—",          status: "in_progress" },
  { label: "A6 Snapshot Availability",  value: "Active",      status: "active"      },
  { label: "Backtest Window",            value: "Available",   status: "active"      },
  { label: "Multi-Asset Coverage",       value: "5 assets",    status: "active"      },
  { label: "Failed Ingestion Count",     value: "—",          status: "in_progress" },
  { label: "Last Successful Backfill",   value: "—",          status: "in_progress" },
];

// ── Execution requirements ────────────────────────────────────────────────────

export const EXECUTION_REQUIREMENTS: ExecutionRequirement[] = [
  { label: "Risk Engine",                   status: "pending"  },
  { label: "Position Sizing",               status: "pending"  },
  { label: "Kill Switch",                   status: "pending"  },
  { label: "Max Drawdown Guard",            status: "pending"  },
  { label: "Open Position Awareness",       status: "pending"  },
  { label: "Recent PnL Throttling",         status: "pending"  },
  { label: "Regime Confidence Threshold",   status: "pending"  },
  { label: "Router Validation",             status: "in_progress" },
  { label: "Slippage Modeling",             status: "pending"  },
];

// ── System events ─────────────────────────────────────────────────────────────

export const SYSTEM_EVENTS: SystemEvent[] = [
  {
    timestamp: "—",
    label: "A6 regime snapshot generated",
    description: "A6 regime snapshot generated for BTC-USD",
    severity: "success",
  },
  {
    timestamp: "—",
    label: "Multi-asset data coverage updated",
    description: "Multi-asset data coverage updated for ETH-USD, SOL-USD, LINK-USD, AVAX-USD",
    severity: "info",
  },
  {
    timestamp: "—",
    label: "Router validation report generated",
    description: "P5 router configuration comparison updated — 5 experimental routers evaluated",
    severity: "info",
  },
  {
    timestamp: "—",
    label: "Walk-forward validation complete",
    description: "Walk-forward router validation: no router validated out-of-sample (0/3 folds across all assets)",
    severity: "warning",
  },
  {
    timestamp: "—",
    label: "Execution layer remains disabled",
    description: "Execution layer remains disabled — risk engine pending implementation",
    severity: "warning",
  },
  {
    timestamp: "—",
    label: "Feature engine audit passed",
    description: "P2D cross-validation: 0 hard failures across all 11 indicators (72/72 bars)",
    severity: "success",
  },
];
