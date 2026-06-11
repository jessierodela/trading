import type { Pool } from "pg";
import type { Exchange, RegimeLabel, Timeframe } from "@/lib/quant/types";
import type {
  BacktestResult,
  BacktestRunRow,
  BacktestTradeRow,
  SimulatedTrade,
} from "./types";

interface RunDbRow {
  id: number;
  public_id: string;
  strategy_id: string;
  strategy_version: string;
  symbol: string;
  exchange: string;
  timeframe: string;
  start_ts: Date;
  end_ts: Date;
  config: unknown;
  metrics: unknown;
  created_at: Date;
}

interface TradeDbRow {
  id: number;
  backtest_run_id: number;
  symbol: string;
  exchange: string;
  direction: string;
  entry_ts: Date;
  entry_price: string;
  exit_ts: Date | null;
  exit_price: string | null;
  quantity: string;
  pnl: string | null;
  pnl_pct: string | null;
  reason_entered: string | null;
  reason_exited: string | null;
  regime_at_entry: string | null;
  inserted_at: Date;
}

export interface BacktestReportStore {
  insertRun(result: BacktestResult): Promise<{ id: number; publicId: string }>;
  insertTrades(runId: number, trades: SimulatedTrade[]): Promise<number>;
  fetchRun(idOrPublicId: string): Promise<BacktestRunRow | null>;
  fetchTrades(runId: number): Promise<BacktestTradeRow[]>;
}

function runRowToBacktest(row: RunDbRow): BacktestRunRow {
  return {
    id: row.id,
    publicId: row.public_id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    symbol: row.symbol,
    exchange: row.exchange as Exchange,
    timeframe: row.timeframe as Timeframe,
    startTs: row.start_ts.toISOString(),
    endTs: row.end_ts.toISOString(),
    config: row.config as BacktestRunRow["config"],
    metrics: row.metrics as BacktestRunRow["metrics"],
    createdAt: row.created_at.toISOString(),
  };
}

function tradeRowToBacktest(row: TradeDbRow): BacktestTradeRow {
  return {
    id: row.id,
    backtestRunId: row.backtest_run_id,
    symbol: row.symbol,
    exchange: row.exchange as Exchange,
    direction: row.direction as "long" | "short",
    entryTs: row.entry_ts.toISOString(),
    entryPrice: Number(row.entry_price),
    exitTs: row.exit_ts?.toISOString() ?? null,
    exitPrice: row.exit_price === null ? null : Number(row.exit_price),
    quantity: Number(row.quantity),
    pnl: row.pnl === null ? null : Number(row.pnl),
    pnlPct: row.pnl_pct === null ? null : Number(row.pnl_pct),
    reasonEntered: row.reason_entered,
    reasonExited: row.reason_exited,
    regimeAtEntry: row.regime_at_entry as RegimeLabel | null,
    insertedAt: row.inserted_at.toISOString(),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export class PgBacktestReportStore implements BacktestReportStore {
  constructor(private readonly pool: Pool) {}

  async insertRun(result: BacktestResult): Promise<{ id: number; publicId: string }> {
    const { rows } = await this.pool.query<RunDbRow>(
      `insert into backtest.runs (
         strategy_id, strategy_version, symbol, exchange, timeframe,
         start_ts, end_ts, config, metrics)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning *`,
      [
        result.config.strategyId,
        result.strategyVersion,
        result.config.symbol,
        result.config.exchange,
        result.config.timeframe,
        result.config.startTs,
        result.config.endTs,
        JSON.stringify(result.config),
        JSON.stringify(result.riskOverlay
          ? { ...result.metrics, riskOverlay: result.riskOverlay }
          : result.metrics),
      ],
    );
    return { id: rows[0].id, publicId: rows[0].public_id };
  }

  async insertTrades(runId: number, trades: SimulatedTrade[]): Promise<number> {
    let inserted = 0;
    for (const trade of trades) {
      await this.pool.query(
        `insert into backtest.trades (
           backtest_run_id, symbol, exchange, direction,
           entry_ts, entry_price, exit_ts, exit_price,
           quantity, pnl, pnl_pct, reason_entered, reason_exited, regime_at_entry)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          runId,
          trade.symbol,
          trade.exchange,
          trade.direction,
          trade.entryTs,
          trade.entryPrice,
          trade.exitTs,
          trade.exitPrice,
          trade.quantity,
          trade.pnl,
          trade.pnlPct,
          trade.reasonEntered,
          trade.reasonExited,
          trade.regimeAtEntry === "UNKNOWN" ? null : trade.regimeAtEntry,
        ],
      );
      inserted++;
    }
    return inserted;
  }

  async fetchRun(idOrPublicId: string): Promise<BacktestRunRow | null> {
    const isNumeric = /^\d+$/.test(idOrPublicId);
    if (!isNumeric && !isUuid(idOrPublicId)) return null;

    const { rows } = await this.pool.query<RunDbRow>(
      `select * from backtest.runs where ${isNumeric ? "id = $1" : "public_id = $1"} limit 1`,
      [idOrPublicId],
    );
    return rows[0] ? runRowToBacktest(rows[0]) : null;
  }

  async fetchTrades(runId: number): Promise<BacktestTradeRow[]> {
    const { rows } = await this.pool.query<TradeDbRow>(
      `select * from backtest.trades where backtest_run_id = $1 order by entry_ts asc, id asc`,
      [runId],
    );
    return rows.map(tradeRowToBacktest);
  }
}

export class InMemoryBacktestReportStore implements BacktestReportStore {
  private runs: BacktestRunRow[] = [];
  private trades: BacktestTradeRow[] = [];
  private nextRunId = 1;
  private nextTradeId = 1;

  async insertRun(result: BacktestResult): Promise<{ id: number; publicId: string }> {
    const id = this.nextRunId++;
    const publicId = `memory-${id}`;
    this.runs.push({
      id,
      publicId,
      strategyId: result.config.strategyId,
      strategyVersion: result.strategyVersion,
      symbol: result.config.symbol,
      exchange: result.config.exchange,
      timeframe: result.config.timeframe,
      startTs: result.config.startTs,
      endTs: result.config.endTs,
      config: result.config,
      metrics: result.riskOverlay
        ? { ...result.metrics, riskOverlay: result.riskOverlay }
        : result.metrics,
      createdAt: result.config.endTs,
    });
    return { id, publicId };
  }

  async insertTrades(runId: number, trades: SimulatedTrade[]): Promise<number> {
    for (const trade of trades) {
      this.trades.push({
        id: this.nextTradeId++,
        backtestRunId: runId,
        symbol: trade.symbol,
        exchange: trade.exchange,
        direction: trade.direction,
        entryTs: trade.entryTs,
        entryPrice: trade.entryPrice,
        exitTs: trade.exitTs,
        exitPrice: trade.exitPrice,
        quantity: trade.quantity,
        pnl: trade.pnl,
        pnlPct: trade.pnlPct,
        reasonEntered: trade.reasonEntered,
        reasonExited: trade.reasonExited,
        regimeAtEntry: trade.regimeAtEntry === "UNKNOWN" ? null : trade.regimeAtEntry,
        insertedAt: trade.entryTs,
      });
    }
    return trades.length;
  }

  async fetchRun(idOrPublicId: string): Promise<BacktestRunRow | null> {
    return this.runs.find((run) => String(run.id) === idOrPublicId || run.publicId === idOrPublicId) ?? null;
  }

  async fetchTrades(runId: number): Promise<BacktestTradeRow[]> {
    return this.trades.filter((trade) => trade.backtestRunId === runId);
  }
}
