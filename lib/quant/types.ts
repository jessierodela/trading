/**
 * lib/quant/types.ts
 *
 * Cross-cutting type contracts for the quant pipeline.
 *
 * This is the spine that P2-P7 bind to. Every later phase imports types from
 * here rather than redefining shapes locally. Changes to this file affect
 * multiple phases — review deliberately.
 *
 * See ARCHITECTURE.md for the decision log that motivates these shapes.
 *
 * What lives here:
 *   - Primitive enums (Timeframe, Direction, Exchange)
 *   - Lineage stamps (versions on every persisted row)
 *   - Market data shapes (Bar)
 *   - Feature shapes (FeatureSnapshot)
 *   - Regime shapes (RegimeContext — re-exported from confluence for ergonomics)
 *   - Strategy shapes (StrategySignal)
 *   - Risk shapes (RiskInput, RiskDecision, RiskConfig)
 *   - Execution shapes (TradeIntent, Order, Fill, Position)
 *   - PnL shape (PnlSnapshot)
 *
 * What does NOT live here:
 *   - Storage implementations (those live in lib/storage/)
 *   - Strategy logic (those live in lib/strategies/)
 *   - Specific risk rules / multipliers (those live in lib/risk/)
 *   - Version values (those live in lib/versions.ts)
 */
import type { SourceLineage } from "@/lib/market/types";

// ─── Primitives ────────────────────────────────────────────────────────────

/**
 * Supported bar timeframes. 1m is the ingestion granularity (aggregated from
 * trade ticks). 5m/15m/1h are cascade rollups. 1d is a daily roll-up for the
 * trend-following / regime context.
 *
 * Adding a timeframe means adding a rollup rule in the bar aggregator and a
 * column policy in the bar store.
 */
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "1d";

/**
 * Directional bias. Used by strategies (long/short/none) and positions.
 *
 * "none" exists for strategies that fire without a directional view
 * (e.g. squeeze detected, no expansion direction yet).
 */
export type Direction = "long" | "short" | "none";

/**
 * The exchange the data came from. Every bar, feature, signal, and trade
 * carries this so we never silently mix venues.
 *
 * Today only COINBASE is wired. Adding venues means extending this union AND
 * deciding how the storage layer treats multi-venue data for the same symbol
 * (we don't — every {symbol, exchange} pair is a separate instrument).
 */
export type Exchange = "COINBASE" | "BINANCE" | "POLYGON";

/**
 * Canonical instrument identity. A bar/feature/signal is fully qualified by
 * (symbol, exchange). BTC-USD on Coinbase and BTC/USDT on Binance are NOT
 * the same instrument and must not share rows.
 */
export interface Instrument {
  symbol:   string;     // e.g. "BTC-USD"
  exchange: Exchange;
}

// ─── Lineage ───────────────────────────────────────────────────────────────

/**
 * Version stamps attached to every persisted row.
 *
 * Not every row uses every field — e.g. a market_bars row only needs
 * data_source_version; a strategy_signals row needs feature_version and
 * strategy_version; a confluence row may need prompt_version and model_version.
 *
 * Compose by picking the fields relevant to the row type. Don't reuse
 * LineageStamp as a single embed — let each table declare its own subset.
 *
 * See lib/versions.ts for the values and bump policy.
 */
export interface LineageStamp {
  /** Which feature engine produced the indicator values. */
  feature_version?:       string;
  /** Which deterministic strategy module produced the signal. */
  strategy_version?:      string;
  /** Which regime detector version classified the bar. */
  regime_model_version?:  string;
  /** Which GPT prompt text was used. */
  prompt_version?:        string;
  /** Which underlying LLM responded (e.g. "gpt-4o-2024-08-06"). */
  model_version?:         string;
  /** Which data source / ingestion code produced the bar. */
  data_source_version?:   string;
  /** Which confluence scorer arbitrated strategy signals into a verdict. */
  confluence_version?:    string;
  /** Which risk engine configuration approved/rejected the trade. */
  risk_version?:          string;
}

// ─── Market data ───────────────────────────────────────────────────────────

/**
 * An OHLCV bar at a closed time interval. Open/high/low/close are required.
 * Volume is nullable because some sources don't expose it cleanly; we'd
 * rather store the bar with null volume than drop it.
 *
 * `ts` is the bar OPEN timestamp (UTC, ISO-8601). Bars are stored as soon
 * as they close — never partial bars.
 */
export interface Bar {
  symbol:    string;
  exchange:  Exchange;
  timeframe: Timeframe;
  ts:        string;            // ISO-8601 UTC, bar open time
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number | null;
  /** Number of trades aggregated into this bar (when source provides it). */
  tradeCount?: number | null;
  /** Provider/source that produced this persisted bar, e.g. coinbase. */
  source?: string | null;
  /** Provider-native symbol before canonical parsing, e.g. BTC/USDT. */
  vendorSymbol?: string | null;
  /** Quote asset proven by the provider symbol, e.g. USD or USDT. */
  quoteAsset?: string | null;
  /** Version stamp for the ingestion code/source when attached in memory. */
  dataSourceVersion?: string | null;
  /** Durable source lineage for downstream audit and data-quality gates. */
  sourceLineage?: SourceLineage;
}

// ─── Features ──────────────────────────────────────────────────────────────

/**
 * Calculated indicators for a single bar. One row per (symbol, timeframe, ts).
 *
 * Field naming convention:
 *   - Standard indicators by name: rsi14, macdHist, ema20, atr14
 *   - Derived/relative quantities suffixed with their unit: atrPct,
 *     distanceFromEma20Atr, candleRangeAtr
 *
 * Adding a field: add to this interface, bump FEATURE_VERSION in versions.ts,
 * and document in the feature engine's CHANGELOG comment.
 *
 * All optional fields are nullable. null means "concept applies but no data
 * for this bar" (e.g. insufficient history for EMA200 yet). Missing key means
 * "this feature wasn't computed at all in this row" (lineage issue).
 */
export interface FeatureSnapshot {
  symbol:    string;
  exchange:  Exchange;
  timeframe: Timeframe;
  ts:        string;
  close:     number;
  source?:   string | null;
  vendorSymbol?: string | null;
  quoteAsset?: string | null;

  // Momentum / oscillators
  rsi14?:        number | null;
  macd?:         number | null;
  macdSignal?:   number | null;
  macdHist?:     number | null;

  // Trend
  ema20?:        number | null;
  ema50?:        number | null;
  ema200?:       number | null;
  ema20Slope?:   number | null;    // ema20[cur] - ema20[prev]
  ema50Slope?:   number | null;
  ema200Slope?:  number | null;

  // Volatility
  atr14?:        number | null;
  atrPct?:       number | null;    // atr14 / close * 100
  bbUpper?:      number | null;
  bbMiddle?:     number | null;
  bbLower?:      number | null;
  bbWidth?:      number | null;
  bbWidthPrev?:  number | null;    // for squeeze/expansion detection

  // Volume
  volumeSma20?:        number | null;
  relativeVolume20?:   number | null;  // volume / volumeSma20

  // Derived position relative to structure
  distanceFromEma20Atr?: number | null;   // (close - ema20) / atr14
  candleRangeAtr?:       number | null;   // (high - low) / atr14

  // Cross-timeframe context (set on 1h rows from 1d feature snapshot)
  daily_ema50AboveEma200?: boolean | null;
  daily_priceAboveEma200?: boolean | null;

  // Lineage
  featureVersion: string;
  sourceLineage?: SourceLineage;
}

// ─── Regime (re-exported from confluence for ergonomic imports) ───────────
// Strategies need regime context as input; they should import from here, not
// reach into lib/confluence. RegimeLabel/RegimeContext are the source of
// truth in lib/confluence/scoreSignals.ts (set during P0).

export type RegimeLabel =
  | "TREND_UP"
  | "TREND_DOWN"
  | "LOW_VOL"
  | "HIGH_VOL"
  | "CHOP"
  | "NEWS_SHOCK";

/**
 * Regime context as consumed by strategies and the risk engine.
 * Sourced from A6 Regime Detector output.
 */
export interface RegimeContext {
  regime:      RegimeLabel;
  reliability: number;          // 0–1
  ts:          string;          // when this regime was classified
}

// ─── Strategy signals (deterministic) ─────────────────────────────────────

/**
 * Setup / trigger / exit type emitted by a strategy.
 *
 * - "setup":       conditions are forming, not yet tradeable
 * - "trigger":     conditions confirmed, this is the trade
 * - "exit":        an existing position should close
 * - "invalidated": setup that was forming has been invalidated, no trade
 */
export type StrategySignalType = "setup" | "trigger" | "exit" | "invalidated";

/**
 * The output of a deterministic strategy on a single bar. One strategy may
 * produce zero or one signal per (symbol, timeframe, ts). Multiple strategies
 * can each produce one — confluence arbitrates.
 *
 * Versioning: every signal stamps both the strategy version that produced it
 * AND the feature version that informed it. This makes backtest replay
 * deterministic — given the same bars and same versions, the same signals.
 */
export interface StrategySignal {
  symbol:           string;
  exchange:         Exchange;
  timeframe:        Timeframe;
  ts:               string;
  strategyId:       string;             // e.g. "momentum_continuation"
  signalType:       StrategySignalType;
  direction:        Direction;
  confidence:       number;             // 0-1, strategy's own conviction
  /** Expected edge in price units (populated post-backtest). */
  expectedEdge?:    number | null;
  /** Price at which this signal is invalidated — usually a swing or ATR stop. */
  invalidationPrice?: number | null;
  /** Suggested stop, may be same as invalidation or risk-engine adjusted. */
  stopLoss?:        number | null;
  /** Suggested take-profit (optional — many strategies trail instead). */
  takeProfit?:      number | null;
  /** Snapshot of the features that produced this signal — for audit. */
  features:         FeatureSnapshot;
  /** Human-readable conditions that fired (e.g. ["price > ema20", "macdHist expanding"]). */
  reasons:          string[];

  // Lineage
  strategyVersion:  string;
  featureVersion:   string;
  sourceLineage?:   SourceLineage;
}

// ─── Risk ──────────────────────────────────────────────────────────────────

/**
 * Account-level configuration the risk engine reads. Lives in DB (one row
 * per account) — passed to the engine per evaluation.
 *
 * Subset of the plan's risk rules (P6). More rules may be added — bump
 * risk_version when behavior changes.
 */
export interface RiskConfig {
  /** Max % of account equity risked on a single trade. */
  maxRiskPerTradePct:    number;       // e.g. 0.005 = 0.5%
  /** Max % of account equity that can be lost in one day before pause. */
  maxDailyLossPct:       number;       // e.g. 0.02 = 2%
  /** Max simultaneous BTC exposure in USD. */
  maxBtcExposureUsd:     number;
  /** Pause new entries after this many consecutive losses. */
  maxConsecutiveLosses:  number;
  /** Reject signals older than this many seconds. */
  maxSignalAgeSec:       number;
  /** Cooldown between entries in the same direction (seconds). */
  reentryCooldownSec:    number;
  /** Global kill switch — when true, all new entries blocked. */
  killSwitchEnabled:     boolean;
}

/**
 * A snapshot of recent PnL for risk decisions. Worker computes this from
 * the positions table; risk engine reads it.
 */
export interface PnlSnapshot {
  realizedPnlToday:    number;
  realizedPnlMtd:      number;
  unrealizedPnl:       number;
  consecutiveLosses:   number;
  asOf:                string;
}

/**
 * Everything the risk engine needs to make a decision on one trade intent.
 */
export interface RiskInput {
  signal:          StrategySignal;
  regime:          RegimeContext | null;   // null = no regime data, fail-open per ARCHITECTURE
  accountEquity:   number;
  openPositions:   Position[];
  recentPnL:       PnlSnapshot[];
  config:          RiskConfig;
}

/**
 * The risk engine's decision on one intent. Approved or not, with reason.
 * Stored on the trade_intents row.
 */
export interface RiskDecision {
  approved:         boolean;
  reason:           string;
  sizeMultiplier:   number;                // 0-1; applied to base size
  positionSize:     number;                // final units (BTC) to trade
  maxRiskUsd:       number;                // USD at risk if stop hits
  stopLoss:         number | null;
  takeProfit:       number | null;
  /** Specific gates that fired. Useful for analytics on what's blocking trades. */
  blockedBy:        string[];

  // Lineage
  riskVersion:      string;
}

// ─── Execution ─────────────────────────────────────────────────────────────

/**
 * Lifecycle status of a trade intent. Linear progression normally; "error"
 * and "cancelled" are terminal off-path states.
 */
export type TradeIntentStatus =
  | "created"
  | "risk_rejected"
  | "risk_approved"
  | "submitted"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "closed"
  | "error";

/**
 * An intent to trade — produced after risk approval. Persisted to
 * trade_intents. Links back to the source strategy signal(s).
 */
export interface TradeIntent {
  id?:                 number;                  // assigned on insert
  symbol:              string;
  exchange:            Exchange;
  ts:                  string;
  /** All strategy signals that contributed to this intent. */
  sourceSignalIds:     number[];
  direction:           Exclude<Direction, "none">;
  status:              TradeIntentStatus;
  entryLogic:          string;                  // brief description
  stopLoss:            number | null;
  takeProfit:          number | null;
  suggestedSize:       number;
  maxRiskUsd:          number;
  riskDecision:        RiskDecision;
}

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus =
  | "pending"
  | "submitted"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "error";

export interface Order {
  id?:               number;
  tradeIntentId:     number;
  symbol:            string;
  exchange:          Exchange;
  side:              OrderSide;
  orderType:         OrderType;
  quantity:          number;
  limitPrice:        number | null;
  status:            OrderStatus;
  externalOrderId:   string | null;   // null for paper orders
  submittedAt:       string | null;
  updatedAt:         string;
}

export interface Fill {
  id?:         number;
  orderId:     number;
  symbol:      string;
  side:        OrderSide;
  quantity:    number;
  price:       number;
  fee:         number;
  filledAt:    string;
  raw?:        unknown;     // exchange-specific payload for audit
}

export type PositionStatus = "open" | "closed";

export interface Position {
  id?:           number;
  symbol:        string;
  exchange:      Exchange;
  status:        PositionStatus;
  direction:     Exclude<Direction, "none">;
  quantity:      number;
  avgEntry:      number;
  stopLoss:      number | null;
  takeProfit:    number | null;
  openedAt:      string;
  closedAt:      string | null;
  realizedPnl:   number | null;
  /** Foreign key back to the intent that opened this position. */
  tradeIntentId: number;
}

// ─── Backtest shapes ───────────────────────────────────────────────────────
// Included here because backtest_runs and backtest_trades are first-class
// outputs of the pipeline, not internal scratch state.

export interface BacktestConfig {
  strategyId:        string;
  strategyVersion:   string;
  symbol:            string;
  exchange:          Exchange;
  timeframe:         Timeframe;
  startTs:           string;
  endTs:             string;
  startingEquity:    number;
  feeBps:            number;             // 10 = 0.10%
  slippageBps:       number;
  riskConfig:        RiskConfig;
}

export interface BacktestMetrics {
  totalReturn:        number;
  cagr?:              number;
  maxDrawdown:        number;
  winRate:            number;
  avgWin:             number;
  avgLoss:            number;
  profitFactor:       number;
  sharpe?:            number;
  sortino?:           number;
  exposureTime:       number;            // fraction of bars in-position
  numTrades:          number;
  avgHoldBars:        number;
  bestTrade:          number;
  worstTrade:         number;
  maxConsecutiveLosses: number;
  /** Per-regime breakdown — e.g. { TREND_UP: { numTrades, winRate, ... } } */
  byRegime:           Record<RegimeLabel, Partial<BacktestMetrics>>;
}

export interface BacktestTrade {
  id?:           number;
  backtestRunId: number;
  symbol:        string;
  direction:     Exclude<Direction, "none">;
  entryTs:       string;
  entryPrice:    number;
  exitTs:        string | null;
  exitPrice:     number | null;
  quantity:      number;
  pnl:           number | null;
  pnlPct:        number | null;
  reasonEntered: string;
  reasonExited:  string | null;
  regimeAtEntry: RegimeLabel | null;
}
