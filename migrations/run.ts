/**
 * migrations/run.ts
 *
 * Apply pending SQL migrations to the database in lexicographic order.
 *
 * Each migration runs in its own transaction. Applied migrations are
 * recorded in the _migrations tracking table. Re-running is a no-op.
 *
 * Connection:
 *   - Reads SUPABASE_DB_URL from env (the direct Postgres connection string,
 *     NOT the supabase-js REST URL). Look for "Connection string" in the
 *     Supabase dashboard → Project Settings → Database.
 *   - Falls back to DATABASE_URL if SUPABASE_DB_URL is not set, which makes
 *     local testing against a plain Postgres easier.
 *
 * Usage:
 *   npx tsx migrations/run.ts            # apply pending migrations
 *   npx tsx migrations/run.ts --status   # show what would run
 *
 * Conventions:
 *   - Migration filenames: NNNN_description.sql (e.g. 0001_initial_schema.sql)
 *   - NNNN must be zero-padded and monotonically increasing.
 *   - Never edit an applied migration. Write a new one to amend.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

// Match files named like 0001_anything.sql
const MIGRATION_RE = /^(\d{4,})_[\w-]+\.sql$/;

const STATUS_ONLY = process.argv.includes("--status");

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => MIGRATION_RE.test(f))
    .sort();   // lexicographic — zero-padded ID makes this correct
}

async function ensureTrackingTable(client: Client): Promise<void> {
  await client.query(`
    create table if not exists _migrations (
      filename     text        primary key,
      applied_at   timestamptz not null default now(),
      checksum     text        not null
    )
  `);
}

async function getAppliedMigrations(client: Client): Promise<Map<string, string>> {
  const { rows } = await client.query<{ filename: string; checksum: string }>(
    `select filename, checksum from _migrations`
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

function hashText(contents: string): string {
  // Cheap, deterministic. We only need to detect "did this file change since
  // it was applied?" — not cryptographic strength.
  // Git may materialize the same tracked SQL as LF or CRLF across hosts.
  let h = 0;
  for (let i = 0; i < contents.length; i++) {
    h = ((h << 5) - h + contents.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}

function checksum(contents: string): string {
  return hashText(contents.replace(/\r\n?/g, "\n"));
}

function acceptedChecksums(contents: string): Set<string> {
  const lf = contents.replace(/\r\n?/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  return new Set([hashText(lf), hashText(crlf)]);
}

async function main(): Promise<void> {
  const dbUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: SUPABASE_DB_URL (or DATABASE_URL) is not set.");
    console.error("In Supabase, find this in Project Settings → Database → Connection string.");
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await ensureTrackingTable(client);
    const applied = await getAppliedMigrations(client);
    const files = listMigrationFiles();

    const pending: { filename: string; sql: string; sum: string }[] = [];
    const drifted: string[] = [];

    for (const filename of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
      const sum = checksum(sql);
      const existing = applied.get(filename);

      if (existing === undefined) {
        pending.push({ filename, sql, sum });
      } else if (!acceptedChecksums(sql).has(existing)) {
        drifted.push(filename);
      }
    }

    if (drifted.length > 0) {
      console.error("ERROR: the following migrations have been edited after application:");
      for (const f of drifted) console.error(`  ${f}`);
      console.error("Never edit an applied migration. Write a new one instead.");
      process.exit(1);
    }

    if (pending.length === 0) {
      console.log(`No pending migrations. ${applied.size} applied.`);
      return;
    }

    console.log(`${applied.size} applied, ${pending.length} pending:`);
    for (const p of pending) console.log(`  ${p.filename}`);

    if (STATUS_ONLY) return;

    for (const p of pending) {
      process.stdout.write(`Applying ${p.filename}... `);
      await client.query("begin");
      try {
        await client.query(p.sql);
        await client.query(
          `insert into _migrations (filename, checksum) values ($1, $2)`,
          [p.filename, p.sum]
        );
        await client.query("commit");
        console.log("ok");
      } catch (err) {
        await client.query("rollback");
        console.log("FAILED");
        console.error(err);
        process.exit(1);
      }
    }

    console.log(`Done. ${pending.length} migration(s) applied.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
