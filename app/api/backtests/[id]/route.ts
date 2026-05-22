import { NextRequest, NextResponse } from "next/server";
import { getPgPool } from "@/lib/storage";
import { PgBacktestReportStore } from "@/lib/backtest/reportStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface ErrorResponse {
  ok: false;
  error: string;
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

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = authError(req);
  if (auth) return auth;
  const { id } = await context.params;

  let pool;
  try {
    pool = getPgPool();
  } catch (err) {
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  const store = new PgBacktestReportStore(pool);
  const run = await store.fetchRun(id);
  if (!run) return NextResponse.json<ErrorResponse>({ ok: false, error: "backtest run not found" }, { status: 404 });

  const trades = await store.fetchTrades(run.id);
  const mode = req.nextUrl.searchParams.get("trades");
  const returnedTrades = mode === "summary"
    ? {
      first: trades[0] ?? null,
      last: trades[trades.length - 1] ?? null,
      sample: trades.slice(0, 10),
    }
    : trades;

  return NextResponse.json({
    ok: true,
    run,
    tradeCount: trades.length,
    trades: returnedTrades,
  });
}

