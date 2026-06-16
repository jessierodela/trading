import { NextRequest, NextResponse } from "next/server";
import {
  listPaperPositions,
  mutatePaperPosition,
  paperTradingAuthResult,
  withPostgresPaperTradingContext,
  type PaperApiError,
  type PaperPositionBody,
} from "@/lib/execution/paperTradingApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function readJson(req: NextRequest): Promise<PaperPositionBody> {
  const text = await req.text();
  if (text.trim().length === 0) return {};
  return JSON.parse(text) as PaperPositionBody;
}

export async function GET(req: NextRequest) {
  const auth = paperTradingAuthResult(req.headers);
  if (auth) return NextResponse.json<PaperApiError>(auth.body, { status: auth.status });

  try {
    const result = await withPostgresPaperTradingContext((ctx) => listPaperPositions(ctx, {
      status: req.nextUrl.searchParams.get("status"),
      symbol: req.nextUrl.searchParams.get("symbol"),
      limit: req.nextUrl.searchParams.get("limit"),
    }));
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return NextResponse.json<PaperApiError>(
      { ok: false, paperOnly: true, stage: "positions", error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = paperTradingAuthResult(req.headers);
  if (auth) return NextResponse.json<PaperApiError>(auth.body, { status: auth.status });

  let body: PaperPositionBody;
  try {
    body = await readJson(req);
  } catch {
    return NextResponse.json<PaperApiError>(
      { ok: false, paperOnly: true, error: "request body is not valid JSON" },
      { status: 400 },
    );
  }

  try {
    const result = await withPostgresPaperTradingContext((ctx) => mutatePaperPosition(ctx, body));
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return NextResponse.json<PaperApiError>(
      { ok: false, paperOnly: true, stage: "position_mutation", error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    );
  }
}
