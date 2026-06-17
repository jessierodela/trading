import { runRegimeRefreshPipeline } from "@/lib/pipeline";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "BTC";
  const result = await runRegimeRefreshPipeline({ symbol });
  return NextResponse.json(result.body, { status: result.status });
}
