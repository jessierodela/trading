import { PostgresJobStore } from "@/lib/jobs/postgresJobStore";
import {
  authorizeSchedulerRequest,
  enqueueScheduledFeed,
} from "@/lib/jobs/scheduler";
import {
  hasRouteDatabaseUrl,
  routeDatabaseUnavailableError,
} from "@/lib/jobs/routeHelpers";
import { getPgPool } from "@/lib/storage";
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
    const store = dryRun ? undefined : new PostgresJobStore(getPgPool());
    const result = await enqueueScheduledFeed({
      store,
      dryRun,
      env: process.env,
      now: new Date(),
    });

    return NextResponse.json(
      {
        ...result,
        protectedBy: auth.reason,
      },
      { status: dryRun ? 200 : 202 },
    );
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
