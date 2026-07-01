import { runRegimeRefreshPipeline } from "@/lib/pipeline";
import { PostgresJobStore } from "@/lib/jobs/postgresJobStore";
import {
  buildRegimeRefreshJob,
  enqueueJobForRoute,
  hasRouteDatabaseUrl,
  isUnsupportedScheduledMarketSymbolError,
  routeDatabaseUnavailableError,
} from "@/lib/jobs/routeHelpers";
import { getPgPool } from "@/lib/storage";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "BTC";

  if (req.nextUrl.searchParams.get("mode") === "sync") {
    // Temporary P8D compatibility path for Markov bot callers. The default
    // path enqueues persisted-feature regime work instead of running inline.
    const result = await runRegimeRefreshPipeline({ symbol });
    return NextResponse.json(result.body, { status: result.status });
  }

  let built: ReturnType<typeof buildRegimeRefreshJob>;
  try {
    built = buildRegimeRefreshJob({ symbol });
  } catch (err) {
    if (isUnsupportedScheduledMarketSymbolError(err)) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    throw err;
  }

  if (!hasRouteDatabaseUrl()) {
    return NextResponse.json(
      { success: false, error: routeDatabaseUnavailableError() },
      { status: 503 },
    );
  }

  let store: PostgresJobStore;
  try {
    store = new PostgresJobStore(getPgPool());
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }

  const { job, deduped } = await enqueueJobForRoute(store, built.payload, {
    dedupeKey: built.dedupeKey,
  });

  return NextResponse.json(
    {
      success: true,
      queued: true,
      jobId: job.publicId,
      status: job.status,
      message: "Regime compute queued",
      symbol: built.payload.jobType === "regime.compute" ? built.payload.symbols[0] : symbol,
      ...(deduped ? { deduped: true } : {}),
    },
    { status: 202 },
  );
}
