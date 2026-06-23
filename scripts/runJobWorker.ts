import os from "node:os";
import { closePgPool, getPgPool } from "@/lib/storage";
import {
  createPostgresJobWorkerOptions,
  runJobWorkerLoop,
  runJobWorkerOnce,
} from "@/lib/jobs/worker";

interface CliArgs {
  mode: "once" | "loop";
  workerId: string;
  pollMs: number;
  leaseMs: number;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_LEASE_MS = 60_000;

function usage(): string {
  return [
    "Usage:",
    "  npm.cmd run worker:jobs -- --once [--worker-id <id>] [--lease-ms <ms>]",
    "  npm.cmd run worker:jobs -- --loop [--worker-id <id>] [--poll-ms <ms>] [--lease-ms <ms>]",
  ].join("\n");
}

function parsePositiveInt(label: string, value: string | undefined): number {
  if (value === undefined) throw new Error(`${label} requires a value`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function parseJobWorkerArgs(argv: string[]): CliArgs {
  let once = false;
  let loop = false;
  let workerId = `${os.hostname()}-${process.pid}`;
  let pollMs = DEFAULT_POLL_MS;
  let leaseMs = DEFAULT_LEASE_MS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--once":
        once = true;
        break;
      case "--loop":
        loop = true;
        break;
      case "--worker-id":
        workerId = argv[++i] ?? "";
        if (workerId.trim().length === 0) throw new Error("--worker-id requires a non-empty value");
        break;
      case "--poll-ms":
        pollMs = parsePositiveInt("--poll-ms", argv[++i]);
        break;
      case "--lease-ms":
        leaseMs = parsePositiveInt("--lease-ms", argv[++i]);
        break;
      case "--help":
      case "-h":
        throw new Error(usage());
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (once === loop) {
    throw new Error("Exactly one of --once or --loop is required");
  }

  return {
    mode: once ? "once" : "loop",
    workerId,
    pollMs,
    leaseMs,
  };
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseJobWorkerArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(usage());
    process.exit(1);
  }

  const controller = new AbortController();
  const shutdown = () => {
    controller.abort();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const pool = getPgPool();
  try {
    const options = createPostgresJobWorkerOptions({
      pool,
      workerId: args.workerId,
      pollMs: args.pollMs,
      leaseMs: args.leaseMs,
      signal: controller.signal,
    });

    if (args.mode === "once") {
      const result = await runJobWorkerOnce(options);
      if (!result.claimed) console.log("[worker:jobs] no queued job available");
      else console.log(`[worker:jobs] job ${result.job?.publicId} finished with status=${result.status}`);
      return;
    }

    console.log(
      `[worker:jobs] loop starting workerId=${args.workerId} pollMs=${args.pollMs} leaseMs=${args.leaseMs}`,
    );
    await runJobWorkerLoop(options);
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await closePgPool();
  }
}

main().catch(async (err) => {
  console.error(err);
  await closePgPool().catch(() => undefined);
  process.exit(1);
});
