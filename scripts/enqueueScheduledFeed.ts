import { PostgresJobStore } from "@/lib/jobs/postgresJobStore";
import { enqueueScheduledFeed, type ScheduledFeedConfigOverrides } from "@/lib/jobs/scheduler";
import { closePgPool, getPgPool } from "@/lib/storage";

interface SchedulerCliArgs {
  once: true;
  dryRun: boolean;
  closedBarTs?: string;
  config: ScheduledFeedConfigOverrides;
}

function usage(): string {
  return [
    "Usage:",
    "  npm.cmd run scheduler:feed -- --once [--dry-run]",
    "  npm.cmd run scheduler:feed -- --once --symbols BTC-USD,ETH-USD --exchange COINBASE --timeframe 1h --source coinbase",
    "  npm.cmd run scheduler:feed -- --once --closed-bar-ts 2026-06-18T14:00:00.000Z",
  ].join("\n");
}

function requireValue(argv: string[], index: number, label: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${label} requires a value`);
  return value;
}

function assertTimestamp(value: string | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("--closed-bar-ts must be a valid ISO timestamp");
  }
}

export function parseSchedulerFeedArgs(argv: string[]): SchedulerCliArgs {
  let once = false;
  let dryRun = false;
  let closedBarTs: string | undefined;
  const config: ScheduledFeedConfigOverrides = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--once":
        once = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--symbols":
        config.symbols = requireValue(argv, i, "--symbols");
        i++;
        break;
      case "--exchange":
        config.exchange = requireValue(argv, i, "--exchange");
        i++;
        break;
      case "--timeframe":
        config.timeframe = requireValue(argv, i, "--timeframe");
        i++;
        break;
      case "--source":
        config.source = requireValue(argv, i, "--source");
        i++;
        break;
      case "--closed-bar-ts":
        closedBarTs = requireValue(argv, i, "--closed-bar-ts");
        i++;
        break;
      case "--help":
      case "-h":
        throw new Error(usage());
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!once) throw new Error("--once is required");
  assertTimestamp(closedBarTs);
  return { once: true, dryRun, closedBarTs, config };
}

async function main(): Promise<void> {
  let args: SchedulerCliArgs;
  try {
    args = parseSchedulerFeedArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(usage());
    process.exit(1);
  }

  const pool = args.dryRun ? null : getPgPool();
  try {
    const result = await enqueueScheduledFeed({
      store: pool ? new PostgresJobStore(pool) : undefined,
      dryRun: args.dryRun,
      config: args.config,
      closedBarTs: args.closedBarTs,
      now: new Date(),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (pool) await closePgPool();
  }
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  await closePgPool().catch(() => undefined);
  process.exit(1);
});
