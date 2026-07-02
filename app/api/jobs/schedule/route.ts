import { PostgresJobStore } from "@/lib/jobs/postgresJobStore";
import {
  authorizeSchedulerRequest,
  enqueueScheduledFeed,
} from "@/lib/jobs/scheduler";
import {
  hasRouteDatabaseUrl,
  routeDatabaseUnavailableError,
} from "@/lib/jobs/routeHelpers";
import { getPgPool, isTransientDbError, withDbRetry } from "@/lib/storage";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const auth = authorizeSchedulerRequest({
    headers: req.headers,
    searchParams: req.nextUrl.searchParams,
    env: process.env,
    nodeEnv: process.env.NODE_ENV,
  });
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: "unauthorized scheduler request", reason: auth.reason },
      { status: 401 },
    );
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  if (!dryRun && !hasRouteDatabaseUrl()) {
    return NextResponse.json(
      { success: false, error: routeDatabaseUnavailableError() },
      { status: 503 },
    );
  }

  try {
    // enqueueScheduledFeed() dedupes every stage against active/succeeded
    // jobs before enqueueing, so retrying the whole call from scratch after
    // a transient failure mid-loop resumes cleanly — already-enqueued
    // stages are found and skipped, never duplicated.
    const result = await withDbRetry(
      "jobs.schedule.enqueue",
      async () => {
        const store = dryRun ? undefined : new PostgresJobStore(getPgPool());
        return enqueueScheduledFeed({
          store,
          dryRun,
          env: process.env,
          now: new Date(),
        });
      },
      { maxAttempts: 2 },
    );

    return NextResponse.json(
      {
        ...result,
        protectedBy: auth.reason,
      },
      { status: dryRun ? 200 : 202 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/jobs/schedule] enqueue failed:", message);
    const transient = isTransientDbError(err);
    return NextResponse.json(
      {
        success: false,
        error: message,
        generatedAt: new Date().toISOString(),
      },
      { status: transient ? 503 : 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
