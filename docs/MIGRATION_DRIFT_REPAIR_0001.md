# Migration drift repair — `0001_initial_schema.sql`

One-time production repair. After this lands, treat `migrations/` as
append-only forever: write a new numbered migration for every schema
change. Do not edit applied migrations.

## Why this exists

`migrations/run.ts` records a checksum of every applied migration in
`_migrations.checksum`. Before applying anything, it re-hashes each
file on disk and refuses to proceed if any recorded checksum no longer
matches. That guard catches the most common production accident:
"someone edited a migration that already ran on prod, and now staging
and prod are out of sync."

The guard is correct. But it is currently false-positive against
`0001_initial_schema.sql` because of a historical edit in commit
`25d4e20` ("p2 cleanup implementation"). That commit:

- Tightened `create schema backtest` → `create schema if not exists backtest`
- Removed two anon-readable RLS policies that the original `0001` created:
  - `anon_read_strategy_signals` on `strategy_signals`
  - `anon_read_agent_outputs` on `agent_outputs`
- Rewrote nearby comments

Production already had `0001` applied at the original checksum, so the
runner now sees drift and aborts before reaching any pending migration
— including `0003_jobs_and_dashboard_snapshots.sql` (P8A) and anything
that comes after it.

## Why a normal `0004` cannot fix this

The runner verifies all stored checksums *first*, then applies pending
files. A regular `0004` that drops the two stale policies never gets a
chance to run, because the `0001` drift check fails the entire batch
before `0004` is touched.

The fix has to update `_migrations.checksum` for `0001` directly, and
that step has to be paired with bringing the database into the state
the edited `0001` describes (so a hypothetical replay-from-scratch
matches production). Both halves commit together, or neither does.

## What the repair does

A single transaction that:

```sql
drop policy if exists anon_read_strategy_signals on strategy_signals;
drop policy if exists anon_read_agent_outputs    on agent_outputs;
alter schema backtest owner to current_user;

update _migrations
   set checksum = <current sha of 0001 on disk>
 where filename = '0001_initial_schema.sql';
```

The checksum is computed with the exact same algorithm
[`migrations/run.ts`](../migrations/run.ts) uses.

The cleanup is idempotent — `drop policy if exists` is a no-op when
the policy is already gone, and re-running the repair after success
prints "nothing to do" and exits 0.

## Running it

Dry-run first. The script prints what it would do and exits without
changing anything unless `CONFIRM_REPAIR_0001_DRIFT=1` is set.

```bash
SUPABASE_DB_URL="postgresql://..." npm run repair:migration:0001
```

Apply:

```bash
CONFIRM_REPAIR_0001_DRIFT=1 SUPABASE_DB_URL="postgresql://..." npm run repair:migration:0001
```

The script prints the stored checksum, the file checksum, and whether
the two stale policies still exist — both before and after the
transaction — and exits nonzero if the repair did not converge.

## Full P8A production validation sequence

Run in this order, once, against the production Supabase project:

```bash
# 1. Repair the 0001 drift so the migrator will run again.
CONFIRM_REPAIR_0001_DRIFT=1 SUPABASE_DB_URL="postgresql://..." npm run repair:migration:0001

# 2. Apply P8A's migration (0003). With 0001 reconciled this no longer aborts.
SUPABASE_DB_URL="postgresql://..." npm run migrate

# 3. Smoke the job queue against the live schema.
#    SMOKE_ALLOW_TRUNCATE=1 acknowledges that the smoke truncates the three
#    P8A tables. It is safe RIGHT NOW because no worker has populated them
#    yet. Do not set SMOKE_ALLOW_TRUNCATE again after the paper-run worker
#    pipeline starts writing real jobs/snapshots.
REQUIRE_DB_SMOKE=1 SMOKE_ALLOW_TRUNCATE=1 SUPABASE_DB_URL="postgresql://..." npm run smoke:jobs
```

## What is and is not in scope

This task is migration drift repair plus smoke truncate hardening.
It does not change routes, does not introduce a worker or scheduler,
does not add live-execution job types, and does not modify any
existing dashboard behavior.

## After this lands

Future schema changes are new numbered migrations only
(`0004_*.sql`, `0005_*.sql`, …). If a migration needs to be revised
after it has been applied anywhere, write the revision as the next
number — never edit a file the runner has already recorded a checksum
for. The repair script in this repo exists specifically because that
rule was broken once before; it should not have to exist again.
