/**
 * lib/storage/interfaces.ts
 *
 * Contracts for the storage layer. Implementations live in sibling files:
 *   - barStore.ts          (Bar I/O)
 *   - featureStore.ts      (FeatureSnapshot I/O)
 *   - signalStore.ts       (StrategySignal I/O)
 *   - regimeStore.ts       (RegimeSnapshot I/O)
 *   - intentStore.ts       (TradeIntent I/O)
 *   - orderStore.ts        (Order I/O)
 *   - fillStore.ts         (Fill I/O)
 *   - positionStore.ts     (Position I/O)
 *   - agentOutputStore.ts  (AgentOutput I/O)
 *
 * Each interface comes in two implementations:
 *   1. Postgres-backed for production (worker code)
 *   2. In-memory mock for tests
 *
 * Design conventions:
 *
 *   - Single-row insert returns the inserted row with assigned id.
 *   - Bulk insert returns the count, not the rows (saves a round trip).
 *   - Range queries take inclusive start, exclusive end (`[start, end)`).
 *   - No "upsert" methods unless explicitly needed. Inserts that violate a
 *     unique constraint throw — caller decides whether to ignore (e.g. via
 *     `onConflictDoNothing` flag) or surface the error. Today only BarStore
 *     supports onConflictDoNothing because backfill reingestion is common.
 *   - All timestamps are ISO-8601 UTC strings on the way in/out. The DB
 *     stores them as timestamptz; conversion is one-way at the boundary.
 *   - All monetary values are numbers (USD for BTC-USD). Be aware of
 *     floating-point — Postgres numeric round-trips through Number lose
 *     precision past ~15 digits. For now this is acceptable; revisit when
 *     position sizes warrant string-based decimals.
 */
import type {
  Bar,
  FeatureSnapshot,
  RegimeContext,
  RegimeLabel,
  StrategySignal,
  TradeIntent,
  Order,
  Fill,
  Position,
  Timeframe,
  Exchange,
} from "@/lib/quant/types";

// ─── Common ────────────────────────────────────────────────────────────────

export interface InstrumentFilter {
  symbol:   string;
  exchange: Exchange;
}

export interface TimeRange {
  /** Inclusive lower bound (ISO-8601). */
  startTs: string;
  /** Exclusive upper bound (ISO-8601). */
  endTs:   string;
}

// ─── BarStore ──────────────────────────────────────────────────────────────

export interface BarStore {
  /**
   * Insert one bar. Returns the inserted row. Throws on conflict.
   * dataSourceVersion is a separate arg because it's a persistence concern,
   * not part of the Bar's domain shape.
   */
  insert(bar: Bar, dataSourceVersion: string): Promise<Bar & { id: number }>;

  /**
   * Insert many bars. Returns count of rows actually inserted.
   * onConflict='ignore' silently skips existing (symbol,exchange,timeframe,ts).
   * onConflict='error' throws on the first conflict.
   */
  insertMany(
    bars:              Bar[],
    dataSourceVersion: string,
    opts?:             { onConflict: "ignore" | "error" },
  ): Promise<number>;

  /** Fetch bars within [startTs, endTs), ordered by ts ascending. */
  fetchRange(
    filter: InstrumentFilter & { timeframe: Timeframe },
    range:  TimeRange,
  ): Promise<Bar[]>;

  /** Fetch the most recent N bars, ordered by ts ascending. */
  fetchRecent(
    filter: InstrumentFilter & { timeframe: Timeframe },
    limit:  number,
  ): Promise<Bar[]>;

  /** The ts of the latest bar present, or null if none. */
  latestTs(filter: InstrumentFilter & { timeframe: Timeframe }): Promise<string | null>;
}

// ─── FeatureStore ──────────────────────────────────────────────────────────

export interface FeatureStore {
  insert(snapshot: FeatureSnapshot): Promise<FeatureSnapshot & { id: number }>;
  insertMany(snapshots: FeatureSnapshot[]): Promise<number>;

  fetchRange(
    filter: InstrumentFilter & { timeframe: Timeframe; featureVersion?: string },
    range:  TimeRange,
  ): Promise<FeatureSnapshot[]>;

  fetchLatest(
    filter: InstrumentFilter & { timeframe: Timeframe; featureVersion?: string },
  ): Promise<FeatureSnapshot | null>;
}

// ─── SignalStore ───────────────────────────────────────────────────────────

export interface SignalStore {
  insert(signal: StrategySignal): Promise<StrategySignal & { id: number }>;

  /** Soft-delete (sets deleted_at). Idempotent — re-retracting is a no-op. */
  retract(id: number, reason?: string): Promise<void>;

  /** Active (not retracted) signals for a strategy in a time range. */
  fetchActiveByStrategy(
    strategyId: string,
    range:      TimeRange,
  ): Promise<(StrategySignal & { id: number })[]>;

  /** Most recent signals for a symbol across all strategies. */
  fetchRecentBySymbol(
    filter: InstrumentFilter,
    limit:  number,
  ): Promise<(StrategySignal & { id: number })[]>;
}

// ─── RegimeStore ───────────────────────────────────────────────────────────

/** Subset of the row needed by consumers; persisted form has more fields. */
export interface RegimeSnapshotRow {
  id?:                 number;
  symbol:              string;
  exchange:            Exchange;
  ts:                  string;
  regime:              RegimeLabel;
  reliability:         number;
  directionalBias:     "UP" | "DOWN" | "NEUTRAL";
  tradePermission:     string;
  edgeMultiplier:      number;
  sizeMultiplier:      number;
  reason:              string | null;
  rawResponse?:        unknown;
  regimeModelVersion:  string;
  promptVersion?:      string | null;
  featureVersion?:     string | null;
}

export interface RegimeStore {
  insert(row: RegimeSnapshotRow): Promise<RegimeSnapshotRow & { id: number }>;

  /** Most recent regime for a symbol, or null. */
  latest(filter: InstrumentFilter): Promise<RegimeSnapshotRow | null>;

  /** Recent regime snapshots, newest first. */
  fetchRecent(filter: InstrumentFilter, limit: number): Promise<RegimeSnapshotRow[]>;

  /** Convenience: latest as RegimeContext (the shape strategies consume). */
  latestAsContext(filter: InstrumentFilter): Promise<RegimeContext | null>;
}

// ─── IntentStore ───────────────────────────────────────────────────────────

export interface IntentStore {
  insert(intent: TradeIntent): Promise<TradeIntent & { id: number }>;
  updateStatus(id: number, status: TradeIntent["status"]): Promise<void>;
  fetchById(id: number): Promise<(TradeIntent & { id: number }) | null>;
  fetchOpen(filter?: Partial<InstrumentFilter>): Promise<(TradeIntent & { id: number })[]>;
}

// ─── OrderStore ────────────────────────────────────────────────────────────

export interface OrderStore {
  insert(order: Order): Promise<Order & { id: number }>;
  updateStatus(id: number, status: Order["status"], externalOrderId?: string): Promise<void>;
  fetchById(id: number): Promise<(Order & { id: number }) | null>;
  fetchOpen(): Promise<(Order & { id: number })[]>;
}

// ─── FillStore ─────────────────────────────────────────────────────────────

export interface FillStore {
  insert(fill: Fill): Promise<Fill & { id: number }>;
  fetchByOrderId(orderId: number): Promise<(Fill & { id: number })[]>;
}

// ─── PositionStore ─────────────────────────────────────────────────────────

export interface PositionStore {
  insert(position: Position): Promise<Position & { id: number }>;
  /** Patch any mutable position field. id required. */
  update(id: number, patch: Partial<Position>): Promise<void>;
  fetchById(id: number): Promise<(Position & { id: number }) | null>;
  fetchOpen(filter?: Partial<InstrumentFilter>): Promise<(Position & { id: number })[]>;
}

// ─── AgentOutputStore ──────────────────────────────────────────────────────

export type AgentRole =
  | "risk_review"
  | "regime_explanation"
  | "setup_interpretation"
  | "post_trade_review"
  | "anomaly_flag"
  | "research_summary";

export interface AgentOutputRow {
  id?:                       number;
  agentId:                   string;
  agentRole:                 AgentRole;
  symbol:                    string | null;
  exchange:                  Exchange | null;
  ts:                        string;
  relatedSignalId?:          number | null;
  relatedIntentId?:          number | null;
  relatedPositionId?:        number | null;
  relatedRegimeSnapshotId?:  number | null;
  summary:                   string;
  details?:                  unknown;
  severity?:                 "info" | "caution" | "alert" | null;
  tags?:                     string[];
  promptVersion:             string;
  modelVersion:              string;
  featureVersion?:           string | null;
}

export interface AgentOutputStore {
  insert(row: AgentOutputRow): Promise<AgentOutputRow & { id: number }>;

  /** Recent outputs anchored to a particular position (e.g. for post-trade review display). */
  fetchByPosition(positionId: number): Promise<AgentOutputRow[]>;

  /** Recent outputs from a particular agent. */
  fetchByAgent(agentId: string, limit: number): Promise<AgentOutputRow[]>;

  /** Recent alerts across all agents. */
  fetchRecentAlerts(limit: number): Promise<AgentOutputRow[]>;
}
