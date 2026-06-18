import { PostgresJobStore } from "@/lib/jobs/postgresJobStore";
import { presentJobs } from "@/lib/jobs/jobStatusPresenter";
import {
  hasRouteDatabaseUrl,
  jobTypeFromQuery,
  routeDatabaseUnavailableError,
} from "@/lib/jobs/routeHelpers";
import { getPgPool } from "@/lib/storage";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseLimit(value: string | null): number | { error: string } {
  if (value === null) return 10;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 50) {
    return { error: "limit must be an integer between 1 and 50" };
  }
  return limit;
}

export async function GET(req: NextRequest) {
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

  const jobId = req.nextUrl.searchParams.get("jobId");
  if (jobId) {
    const job = await store.fetchJob(jobId);
    return NextResponse.json({
      success: true,
      jobs: job ? presentJobs([job]) : [],
    });
  }

  const jobType = jobTypeFromQuery(req.nextUrl.searchParams.get("jobType"));
  if (jobType && typeof jobType !== "string") {
    return NextResponse.json({ success: false, error: jobType.error }, { status: 400 });
  }

  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));
  if (typeof limit !== "number") {
    return NextResponse.json({ success: false, error: limit.error }, { status: 400 });
  }

  const activeOnly = req.nextUrl.searchParams.get("active") === "1";
  const jobs = await store.listJobs({
    status: activeOnly ? ["queued", "running"] : undefined,
    jobType,
    limit,
  });

  return NextResponse.json({
    success: true,
    jobs: presentJobs(jobs),
  });
}
