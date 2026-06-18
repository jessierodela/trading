import { PostgresJobStore } from "@/lib/jobs/postgresJobStore";
import { presentJob } from "@/lib/jobs/jobStatusPresenter";
import {
  hasRouteDatabaseUrl,
  routeDatabaseUnavailableError,
} from "@/lib/jobs/routeHelpers";
import { getPgPool } from "@/lib/storage";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

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

  const job = await store.fetchJob(id);
  if (!job) {
    return NextResponse.json({ success: false, error: "job_not_found" }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    job: presentJob(job),
  });
}
