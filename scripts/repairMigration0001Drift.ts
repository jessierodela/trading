/**
 * scripts/repairMigration0001Drift.ts
 *
 * One-off repair for historical drift in migrations/0001_initial_schema.sql.
 *
 * Background
 * ----------
 * 0001 was edited after it had been applied to production (commit 25d4e20,
 * "p2 cleanup implementation", far pre-P8). The edit:
 *   - tightened `create schema backtest`        -> `create schema if not exists backtest`
 *   - removed two anon-readable RLS policies that were originally created:
 *       anon_read_strategy_signals  on strategy_signals
 *       anon_read_agent_outputs     on agent_outputs
 *   - rewrote nearby comments
 *
 * migrations/run.ts refuses to apply any pending migration when an already-
 * applied migration's recorded checksum no longer matches the file on disk.
 * That guard is correct in general, but it now blocks 0003 (P8A) and every
 * future migration until this one historical drift is reconciled. A normal
 * numbered 0004 cannot reconcile it, because the runner stops at the 0001
 * checksum check before it ever reaches 0004.
 *
 * What this script does
 * ---------------------
 * Brings the production database into the state the edited 0001 file
 * describes (drops the two now-removed anon policies, normalizes schema
 * ownership), then updates _migrations.checksum for 0001 to match the
 * current file contents. The two changes commit together — if either
 * fails, neither lands.
 *
 * Safety
 * ------
 *  - Dry-run by default. Requires CONFIRM_REPAIR_0001_DRIFT=1 to apply.
 *  - Idempotent: the cleanup uses `drop policy if exists`, and a second run
 *    after success reports "nothing to do".
 *  - Refuses to repair a database that has never recorded 0001 in
 *    _migrations — that DB should be bootstrapped with `npm run migrate`,
 *    not patched.
 *  - One-time-only: this is not a general drift fix. Future schema changes
 *    must be a new numbered migration. Do not edit applied migrations.
 *
 * Usage
 * -----
 *   # dry-run (default)
 *   SUPABASE_DB_URL="..." npm run repair:migration:0001
 *
 *   # apply
 *   CONFIRM_REPAIR_0001_DRIFT=1 SUPABASE_DB_URL="..." npm run repair:migration:0001
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATION_FILENAME = "0001_initial_schema.sql";

// Must stay byte-identical to migrations/run.ts:checksum.
function checksum(contents: string): string {
  let h = 0;
  for (let i = 0; i < contents.length; i++) {
    h = ((h << 5) - h + contents.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}

interface PolicyRow {
  policyname: string;
  tablename: string;
}

const STALE_POLICY_FILTER = `
  (policyname = 'anon_read_strategy_signals' and tablename = 'strategy_signals')
  or (policyname = 'anon_read_agent_outputs' and tablename = 'agent_outputs')
`;

async function getStoredChecksum(client: Client): Promise<string | null> {
  const { rows } = await client.query<{ checksum: string }>(
    `select checksum from _migrations where filename = $1`,
    [MIGRATION_FILENAME],
  );
  return rows[0]?.checksum ?? null;
}

async function staleAnonPolicies(client: Client): Promise<PolicyRow[]> {
  const { rows } = await client.query<PolicyRow>(
    `select policyname, tablename
       from pg_policies
      where ${STALE_POLICY_FILTER}
      order by tablename, policyname`,
  );
  return rows;
}

function describePolicies(label: string, policies: PolicyRow[]): void {
  console.log(`  ${label} (${policies.length}):`);
  for (const p of policies) console.log(`    - ${p.tablename}.${p.policyname}`);
}

async function main(): Promise<void> {
  const dbUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: SUPABASE_DB_URL (or DATABASE_URL) is not set.");
    console.error("In Supabase, find this in Project Settings → Database → Connection string.");
    process.exit(1);
  }
  const confirm = process.env.CONFIRM_REPAIR_0001_DRIFT === "1";

  const migrationPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "migrations",
    MIGRATION_FILENAME,
  );
  const fileContents = readFileSync(migrationPath, "utf8");
  const fileChecksum = checksum(fileContents);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const storedBefore = await getStoredChecksum(client);
    if (storedBefore === null) {
      console.error(`ERROR: ${MIGRATION_FILENAME} is not recorded in _migrations.`);
      console.error("Either the DB has never been migrated, or the tracking row was deleted.");
      console.error("Refusing to repair — bootstrap a fresh DB with `npm run migrate` instead.");
      process.exit(1);
    }

    const policiesBefore = await staleAnonPolicies(client);
    const drifted = storedBefore !== fileChecksum;

    console.log("=== migration 0001 drift status: BEFORE ===");
    console.log(`  file:             migrations/${MIGRATION_FILENAME}`);
    console.log(`  file checksum:    ${fileChecksum}`);
    console.log(`  stored checksum:  ${storedBefore}`);
    console.log(`  drifted:          ${drifted}`);
    describePolicies("stale anon policies present", policiesBefore);

    if (!drifted && policiesBefore.length === 0) {
      console.log("\nNothing to do — checksum matches and stale policies are already gone.");
      return;
    }

    const plannedSql = [
      "drop policy if exists anon_read_strategy_signals on strategy_signals;",
      "drop policy if exists anon_read_agent_outputs on agent_outputs;",
      "alter schema backtest owner to current_user;",
      `update _migrations set checksum = '${fileChecksum}' where filename = '${MIGRATION_FILENAME}';`,
    ];

    if (!confirm) {
      console.log("\n=== DRY RUN (CONFIRM_REPAIR_0001_DRIFT is not set) ===");
      console.log("Would execute, in a single transaction:");
      for (const stmt of plannedSql) console.log(`  ${stmt}`);
      console.log("\nRe-run with CONFIRM_REPAIR_0001_DRIFT=1 to apply.");
      return;
    }

    console.log("\n=== APPLYING REPAIR ===");
    await client.query("begin");
    try {
      await client.query("drop policy if exists anon_read_strategy_signals on strategy_signals");
      await client.query("drop policy if exists anon_read_agent_outputs on agent_outputs");
      await client.query("alter schema backtest owner to current_user");
      const updated = await client.query(
        `update _migrations set checksum = $1 where filename = $2`,
        [fileChecksum, MIGRATION_FILENAME],
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `expected to update exactly 1 _migrations row, updated ${updated.rowCount}`,
        );
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    }

    const storedAfter = await getStoredChecksum(client);
    const policiesAfter = await staleAnonPolicies(client);
    const checksumsMatch = storedAfter === fileChecksum;
    const policiesGone = policiesAfter.length === 0;

    console.log("\n=== migration 0001 drift status: AFTER ===");
    console.log(`  file checksum:    ${fileChecksum}`);
    console.log(`  stored checksum:  ${storedAfter}`);
    console.log(`  checksums match:  ${checksumsMatch}`);
    describePolicies("stale anon policies present", policiesAfter);

    if (!checksumsMatch || !policiesGone) {
      console.error("\nERROR: repair did not converge.");
      process.exit(1);
    }
    console.log("\nRepair converged. Run `npm run migrate` next to apply pending migrations.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
