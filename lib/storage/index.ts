/**
 * lib/storage/index.ts
 *
 * Re-exports for the storage layer. Consumers import from "@/lib/storage".
 */

export * from "./interfaces";

export {
  getPgPool,
  closePgPool,
  withPooledClient,
  detectPgPoolRuntime,
  resolvePgPoolConfig,
  type PgPoolRuntime,
  type ResolvedPgPoolConfig,
  type GetPgPoolOptions,
} from "./clients";

export { validateBar, validateFeatureSnapshot, ValidationError } from "./validators";

export { withDbRetry, isTransientDbError, type DbRetryOptions } from "./dbRetry";

export { PgBarStore,      InMemoryBarStore }      from "./barStore";
export { PgFeatureStore,  InMemoryFeatureStore }  from "./featureStore";
export { PgSignalStore,   InMemorySignalStore }   from "./signalStore";
export { PgRegimeStore,   InMemoryRegimeStore }   from "./regimeStore";
