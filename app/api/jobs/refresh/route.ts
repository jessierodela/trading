import { PostgresJobStore } from "@/lib/jobs/postgresJobStore";
import {
  buildRefreshJobRequest,
  enqueueJobForRoute,
  hasRouteDatabaseUrl,
  routeDatabaseUnavailableError,
} from "@/lib/jobs/routeHelpers";
import { getPgPool } from "@/lib/storage";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    const text = await req.text();
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ success: false, error: "request body is not valid JSON" }, { status: 400 });
  }

  const built = buildRefreshJobRequest(body);
  if ("error" in built) {
    return NextResponse.json({ success: false, error: built.error }, { status: 400 });
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
      jobType: job.jobType,
      status: job.status,
      message: built.message,
      ...(deduped ? { deduped: true } : {}),
    },
    { status: 202 },
  );
}
