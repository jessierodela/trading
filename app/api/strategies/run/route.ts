import { NextRequest, NextResponse } from "next/server";
import {
  getPgPool,
  PgFeatureStore,
  PgSignalStore,
} from "@/lib/storage";
import { runStrategyWindow } from "@/lib/strategies/runStrategyWindow";
import { FEATURE_VERSION } from "@/lib/versions";
import type { Exchange, Timeframe } from "@/lib/quant/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOWED_TIMEFRAMES: Timeframe[] = ["1h"];
const ALLOWED_EXCHANGES: Exchange[] = ["COINBASE", "BINANCE", "POLYGON"];

interface RunStrategiesBody {
  symbol?: string;
  exchange?: string;
  timeframe?: string;
  startTs?: string;
  endTs?: string;
  persist?: boolean;
  featureVersion?: string;
}

interface ResolvedParams {
  symbol: string;
  exchange: Exchange;
  timeframe: Timeframe;
  startTs: string;
  endTs: string;
  persist: boolean;
  featureVersion: string;
}

interface ErrorResponse {
  ok: false;
  error: string;
}

function parseAndValidate(body: RunStrategiesBody): ResolvedParams | { error: string } {
  if (!body.symbol || typeof body.symbol !== "string") return { error: "symbol is required" };
  if (!body.exchange || !ALLOWED_EXCHANGES.includes(body.exchange as Exchange)) {
    return { error: `exchange is required and must be one of ${ALLOWED_EXCHANGES.join(", ")}` };
  }
  if (!body.timeframe || !ALLOWED_TIMEFRAMES.includes(body.timeframe as Timeframe)) {
    return { error: "timeframe is required and must be 1h for this phase" };
  }
  if (!body.startTs || !body.endTs) return { error: "startTs and endTs are required" };

  const startMs = Date.parse(body.startTs);
  const endMs = Date.parse(body.endTs);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return { error: `invalid startTs/endTs: ${body.startTs} / ${body.endTs}` };
  }
  if (startMs >= endMs) return { error: "startTs must be < endTs" };

  return {
    symbol: body.symbol,
    exchange: body.exchange as Exchange,
    timeframe: body.timeframe as Timeframe,
    startTs: body.startTs,
    endTs: body.endTs,
    persist: body.persist ?? false,
    featureVersion: body.featureVersion ?? FEATURE_VERSION,
  };
}

export async function POST(req: NextRequest) {
  const configured = process.env.STRATEGIES_SECRET ?? process.env.BACKFILL_SECRET;
  if (!configured) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "STRATEGIES_SECRET or BACKFILL_SECRET not configured on server - route refuses to run" },
      { status: 503 },
    );
  }
  const supplied = req.headers.get("x-backfill-secret");
  if (supplied !== configured) {
    return NextResponse.json<ErrorResponse>({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: RunStrategiesBody;
  try {
    const text = await req.text();
    body = text.length > 0 ? JSON.parse(text) as RunStrategiesBody : {};
  } catch {
    return NextResponse.json<ErrorResponse>({ ok: false, error: "request body is not valid JSON" }, { status: 400 });
  }

  const parsed = parseAndValidate(body);
  if ("error" in parsed) {
    return NextResponse.json<ErrorResponse>({ ok: false, error: parsed.error }, { status: 400 });
  }

  let pool;
  try {
    pool = getPgPool();
  } catch (err) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: `pg pool init failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  const featureStore = new PgFeatureStore(pool);
  const signalStore = new PgSignalStore(pool);
  const features = await featureStore.fetchRange(
    {
      symbol: parsed.symbol,
      exchange: parsed.exchange,
      timeframe: parsed.timeframe,
      featureVersion: parsed.featureVersion,
    },
    { startTs: parsed.startTs, endTs: parsed.endTs },
  );

  const dailyFeatures = await featureStore.fetchRange(
    {
      symbol: parsed.symbol,
      exchange: parsed.exchange,
      timeframe: "1d",
      featureVersion: parsed.featureVersion,
    },
    { startTs: parsed.startTs, endTs: parsed.endTs },
  );

  const result = await runStrategyWindow({
    features,
    dailyFeatures,
    signalStore,
    persist: parsed.persist,
  });

  return NextResponse.json({
    ok: true,
    featuresRead: result.featuresRead,
    signalsEmitted: result.signals.length,
    inserted: result.inserted,
    duplicatesSkipped: result.duplicatesSkipped,
    byStrategy: result.byStrategy,
    latestSignals: result.signals.slice(-5),
  });
}

