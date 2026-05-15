# lib/storage

The persistence boundary. Everything that reads or writes to Postgres goes
through here.

## What's here

| File | Purpose |
|---|---|
| `interfaces.ts` | All store contracts in one place. Implementations bind to these. |
| `clients.ts` | `getPgPool()` — pg connection pool (worker side). |
| `barStore.ts` | OHLCV bar I/O. `PgBarStore` (prod) and `InMemoryBarStore` (tests). |
| `featureStore.ts` | Feature snapshot I/O. |
| `signalStore.ts` | Deterministic strategy signal I/O. Soft-delete via `retract`. |
| `regimeStore.ts` | Regime snapshot I/O. Provides `latestAsContext()` for strategies. |
| `index.ts` | Re-exports. Import from `@/lib/storage`. |

Stores for `trade_intents`, `orders`, `fills`, `positions`, `agent_outputs`
will land alongside these when P6/P7 wire them up. The interfaces for those
already exist in `interfaces.ts`.

## How to use it

### Worker side (Railway)

```ts
import { getPgPool, PgBarStore } from "@/lib/storage";

const bars = new PgBarStore(getPgPool());
await bars.insertMany(freshBars, "coinbase.ws.v1", { onConflict: "ignore" });
```

The pool is a process-level singleton. Call `closePgPool()` on shutdown.

### Tests

```ts
import { InMemoryBarStore } from "@/lib/storage";

const bars = new InMemoryBarStore();
await bars.insert(bar, "test");
```

In-memory stores satisfy the same interface — strategies, feature engines,
etc. can be tested without a database.

## Environment variables

| Var | Required | Used by |
|---|---|---|
| `SUPABASE_DB_URL` | yes (worker) | `getPgPool()`, migrations |
| `DATABASE_URL` | fallback | `getPgPool()`, migrations |

Get `SUPABASE_DB_URL` from Supabase dashboard → Project Settings → Database
→ Connection string → URI tab. Use the **direct connection** for migrations
and the **transaction pooler** for the worker (port 6543 vs 5432) — the
pooler is what handles the connection limits.

## Conventions

- **Timestamps are ISO-8601 UTC strings** on both ends of the interface.
  Postgres stores `timestamptz`; conversion happens in the row mappers.
- **`numeric` columns come back from pg as strings.** The row mappers
  `Number()` them. Precision loss past ~15 digits is acceptable today;
  revisit if position sizes grow large.
- **No upserts unless the store explicitly supports `onConflict`.** Today
  only `BarStore.insertMany` does, because re-ingesting bars during
  backfill is expected. Other tables prefer to fail loudly.
- **Soft delete via `deleted_at`** on `strategy_signals` and `trade_intents`.
  Hard delete is never the right tool for an audit row.

## Vercel-side reads (not yet implemented)

The current stores use `pg` directly, which works on the worker but not in
serverless functions (no persistent pool across cold starts; connection
limit pressure).

For the Next.js API routes, the planned approach is a **supabase-js read
client** living next to `clients.ts` and a separate set of read-only store
implementations. When P3 ships the dashboard rewrite, that lands then.

## Adding a new store

1. Add the interface to `interfaces.ts`.
2. Add a new file `xxxStore.ts` with `PgXxxStore` and `InMemoryXxxStore`.
3. Re-export from `index.ts`.
4. Add a smoke test in `_smoke_storage.ts` (or whatever the test entry is)
   covering both implementations against the same scenarios.

## Adding a new column

If you're adding a feature column:
1. Write a new migration (`0002_add_X.sql`).
2. Add the field to `FeatureSnapshot` in `lib/quant/types.ts`.
3. Add the `{col, field}` entry to `FEATURE_COLS` in `featureStore.ts`.
4. Bump `FEATURE_VERSION` in `lib/versions.ts` and CHANGELOG it.
