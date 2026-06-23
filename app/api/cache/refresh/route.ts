import { runDashboardRefreshPipeline } from "@/lib/pipeline";
import { PostgresJobStore } from "@/lib/jobs/postgresJobStore";
import {
  buildDashboardRefreshJob,
  enqueueJobForRoute,
  hasRouteDatabaseUrl,
  routeDatabaseUnavailableError,
} from "@/lib/jobs/routeHelpers";
import { getPgPool } from "@/lib/storage";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get("mode") === "sync") {
    // Temporary P8D compatibility path for older callers. The default path
    // below enqueues and never runs dashboard refresh work inline.
    const result = await runDashboardRefreshPipeline();
    return NextResponse.json(result.body, { status: result.status });
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

  const built = buildDashboardRefreshJob();
  const { job, deduped } = await enqueueJobForRoute(store, built.payload, {
    dedupeKey: built.dedupeKey,
  });

  return NextResponse.json(
    {
      success: true,
      queued: true,
      jobId: job.publicId,
      status: job.status,
      message: "Dashboard refresh queued",
      ...(deduped ? { deduped: true } : {}),
    },
    { status: 202 },
  );
}
