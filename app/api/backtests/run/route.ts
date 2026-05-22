import { NextRequest, NextResponse } from "next/server";
import {
  getPgPool,
  PgBarStore,
  PgFeatureStore,
} from "@/lib/storage";
import { runBacktest } from "@/lib/backtest/backtestEngine";
import { PgBacktestReportStore } from "@/lib/backtest/reportStore";
import { FEATURE_VERSION } from "@/lib/versions";
import type { BacktestConfig } from "@/lib/backtest/types";
import type { Exchange, RegimeContext, Timeframe } from "@/lib/quant/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface RunBacktestBody {
  symbol?: string;
  exchange?: string;
  timeframe?: string;
  strategyId?: string;
  featureVersion?: string;
  startTs?: string;
  endTs?: string;
  initialCapital?: number;
  riskPerTradePct?: number;
  maxPositionPct?: number;
  feeBps?: number;
  slippageBps?: number;
  defaultRewardRisk?: number;
  closeOpenPositionAtEnd?: boolean;
  persist?: boolean;
}

interface ErrorResponse {
  ok: false;
  error: string;
  stage?: string;
}

const ALLOWED_EXCHANGES: Exchange[] = ["COINBASE", "BINANCE", "POLYGON"];
const ALLOWED_TIMEFRAMES: Timeframe[] = ["1h"];

function isAllowedExchange(value: string | undefined): value is Exchange {
  return value !== undefined && ALLOWED_EXCHANGES.includes(value as Exchange);
}

function isAllowedTimeframe(value: string | undefined): value is Timeframe {
  return value !== undefined && ALLOWED_TIMEFRAMES.includes(value as Timeframe);
}

function authError(req: NextRequest): NextResponse<ErrorResponse> | null {
  const configured = process.env.BACKTEST_SECRET ?? process.env.STRATEGIES_SECRET ?? process.env.BACKFILL_SECRET;
  if (!configured) {
    return NextResponse.json(
      { ok: false, error: "BACKTEST_SECRET, STRATEGIES_SECRET, or BACKFILL_SECRET not configured" },
      { status: 503 },
    );
  }
  if (req.headers.get("x-backfill-secret") !== configured) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function parseConfig(body: RunBacktestBody): { config: BacktestConfig; persist: boolean } | { error: string } {
  if (!body.symbol) return { error: "symbol is required" };
  if (!body.exchange) return { error: "exchange is required" };
  if (!isAllowedExchange(body.exchange)) {
    return { error: `exchange must be one of: ${ALLOWED_EXCHANGES.join(", ")}` };
  }
  if (!isAllowedTimeframe(body.timeframe)) {
    return { error: "timeframe is required and must be 1h in v1" };
  }
  if (!body.strategyId || body.strategyId === "all") return { error: "strategyId is required and must be one strategy id" };
  if (!body.startTs || !body.endTs) return { error: "startTs and endTs are required" };
  const startMs = Date.parse(body.startTs);
  const endMs = Date.parse(body.endTs);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return { error: "startTs and endTs must be valid timestamps" };
  if (startMs >= endMs) return { error: "startTs must be < endTs" };

  return {
    persist: body.persist ?? true,
    config: {
      symbol: body.symbol,
      exchange: body.exchange,
      timeframe: body.timeframe,
      strategyId: body.strategyId,
      featureVersion: body.featureVersion ?? FEATURE_VERSION,
      startTs: body.startTs,
      endTs: body.endTs,
      initialCapital: body.initialCapital ?? 10_000,
      riskPerTradePct: body.riskPerTradePct ?? 0.005,
      maxPositionPct: body.maxPositionPct ?? 1.0,
      maxConcurrentPositions: 1,
      feeBps: body.feeBps ?? 10,
      slippageBps: body.slippageBps ?? 5,
      defaultRewardRisk: body.defaultRewardRisk ?? 2,
      closeOpenPositionAtEnd: body.closeOpenPositionAtEnd ?? true,
      enterOnNextBarOpen: true,
      sameBarStopFirst: true,
    },
  };
}

function subtractUtcDays(ts: string, days: number): string {
  return new Date(Date.parse(ts) - days * 24 * 60 * 60 * 1000).toISOString();
}

async function fetchRegimes(pool: ReturnType<typeof getPgPool>, config: BacktestConfig): Promise<RegimeContext[]> {
  const { rows } = await pool.query<{ ts: Date; regime: string; reliability: string }>(
    `select ts, regime, reliability from regime_snapshots
     where symbol = $1 and exchange = $2 and ts >= $3 and ts < $4
     order by ts asc`,
    [config.symbol, config.exchange, subtractUtcDays(config.startTs, 7), config.endTs],
  );
  return rows.map((row) => ({
    ts: row.ts.toISOString(),
    regime: row.regime as RegimeContext["regime"],
    reliability: Number(row.reliability),
  }));
}

export async function POST(req: NextRequest) {
  const auth = authError(req);
  if (auth) return auth;

  let body: RunBacktestBody;
  try {
    const text = await req.text();
    body = text.length > 0 ? JSON.parse(text) as RunBacktestBody : {};
  } catch {
    return NextResponse.json<ErrorResponse>({ ok: false, error: "request body is not valid JSON" }, { status: 400 });
  }

  const parsed = parseConfig(body);
  if ("error" in parsed) return NextResponse.json<ErrorResponse>({ ok: false, error: parsed.error }, { status: 400 });
  const { config, persist } = parsed;

  let pool;
  try {
    pool = getPgPool();
  } catch (err) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, stage: "pool", error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  try {
    const barStore = new PgBarStore(pool);
    const featureStore = new PgFeatureStore(pool);
    const reportStore = new PgBacktestReportStore(pool);

    const [bars, features, dailyFeatures, regimes] = await Promise.all([
      barStore.fetchRange(
        { symbol: config.symbol, exchange: config.exchange, timeframe: config.timeframe },
        { startTs: config.startTs, endTs: config.endTs },
      ),
      featureStore.fetchRange(
        { symbol: config.symbol, exchange: config.exchange, timeframe: config.timeframe, featureVersion: config.featureVersion },
        { startTs: config.startTs, endTs: config.endTs },
      ),
      featureStore.fetchRange(
        { symbol: config.symbol, exchange: config.exchange, timeframe: "1d", featureVersion: config.featureVersion },
        { startTs: subtractUtcDays(config.startTs, 3), endTs: config.endTs },
      ),
      fetchRegimes(pool, config),
    ]);

    const result = runBacktest({ config, bars, features, dailyFeatures, regimes });
    let persisted: { id: number; publicId: string; tradesInserted: number } | null = null;
    if (persist) {
      const run = await reportStore.insertRun(result);
      const tradesInserted = await reportStore.insertTrades(run.id, result.trades);
      persisted = { ...run, tradesInserted };
    }

    return NextResponse.json({
      ok: true,
      persisted,
      strategyId: config.strategyId,
      strategyVersion: result.strategyVersion,
      tradeCount: result.trades.length,
      metrics: {
        endingEquity: result.metrics.endingEquity,
        totalReturnPct: result.metrics.totalReturnPct,
        maxDrawdownPct: result.metrics.maxDrawdownPct,
        winRatePct: result.metrics.winRatePct,
        profitFactor: result.metrics.profitFactor,
        numberOfTrades: result.metrics.numberOfTrades,
      },
      firstTrade: result.trades[0] ?? null,
      lastTrade: result.trades[result.trades.length - 1] ?? null,
      notes: result.metrics.notes,
    });
  } catch (err) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, stage: "backtest", error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    );
  }
}
