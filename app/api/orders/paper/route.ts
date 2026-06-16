import { NextRequest, NextResponse } from "next/server";
import {
  createPaperOrderFromIntent,
  paperTradingAuthResult,
  withPostgresPaperTradingContext,
  type PaperApiError,
  type CreatePaperOrderBody,
} from "@/lib/execution/paperTradingApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function readJson(req: NextRequest): Promise<CreatePaperOrderBody | null> {
  const text = await req.text();
  if (text.trim().length === 0) return {};
  return JSON.parse(text) as CreatePaperOrderBody;
}

export async function POST(req: NextRequest) {
  const auth = paperTradingAuthResult(req.headers);
  if (auth) return NextResponse.json<PaperApiError>(auth.body, { status: auth.status });

  let body: CreatePaperOrderBody | null;
  try {
    body = await readJson(req);
  } catch {
    return NextResponse.json<PaperApiError>(
      { ok: false, paperOnly: true, error: "request body is not valid JSON" },
      { status: 400 },
    );
  }

  try {
    const result = await withPostgresPaperTradingContext((ctx) => createPaperOrderFromIntent(ctx, body ?? {}));
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return NextResponse.json<PaperApiError>(
      { ok: false, paperOnly: true, stage: "paper_order", error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    );
  }
}
