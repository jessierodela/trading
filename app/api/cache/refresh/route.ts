import { runDashboardRefreshPipeline } from "@/lib/pipeline";
import { NextResponse } from "next/server";

export async function POST() {
  const result = await runDashboardRefreshPipeline();
  return NextResponse.json(result.body, { status: result.status });
}
