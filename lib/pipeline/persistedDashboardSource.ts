/**
 * lib/pipeline/persistedDashboardSource.ts
 *
 * P10B — dashboard.snapshot data source.
 *
 * Builds CacheAdapter<CacheSnapshot>/CacheAdapter<CacheSnapshot1d> instances
 * backed by persisted feature_snapshots (via FeatureStore) instead of the
 * live TAAPI-backed indicator cache. Feeding these adapters into
 * runDashboardRefreshPipeline lets the existing deterministic
 * agent/regime/confluence logic run unchanged while the data underneath it
 * comes from Postgres, not TAAPI.
 *
 * lib/indicatorCache.ts / lib/taapi.ts / lib/taapi1d.ts are never imported or
 * called here — only their (type-only) snapshot shapes are reused so the
 * downstream pipeline code doesn't need to change.
 */
import type { CacheSnapshot } from "@/lib/indicatorCache";
import type { CacheSnapshot1d } from "@/lib/indicatorCache1d";
import { adaptFeatureSnapshotsToRegimeDetectorInput } from "@/lib/pipeline/regimeRefreshPipeline";
import type { CacheAdapter, NowFn } from "@/lib/pipeline/types";
import type { Exchange, FeatureSnapshot, Timeframe } from "@/lib/quant/types";
import type { FeatureStore } from "@/lib/storage/interfaces";

export interface PersistedFeatureCacheAdapters {
  cache: CacheAdapter<CacheSnapshot>;
  cache1d: CacheAdapter<CacheSnapshot1d>;
}

export interface CreatePersistedFeatureCacheAdaptersInput {
  featureStore: Pick<FeatureStore, "fetchLatest">;
  symbols: string[];
  exchange: Exchange;
  timeframe?: Extract<Timeframe, "1h">;
  now?: NowFn;
}

/**
 * Builds a pair of CacheAdapter implementations that read the latest
 * persisted feature_snapshots row per symbol (1h + 1d) instead of hitting
 * TAAPI. Both adapters share one underlying fetch — forceRefresh() on either
 * loads both timeframes, so the second forceRefresh() call is a no-op.
 */
export function createPersistedFeatureCacheAdapters(
  input: CreatePersistedFeatureCacheAdaptersInput,
): PersistedFeatureCacheAdapters {
  const timeframe = input.timeframe ?? "1h";
  let snapshot: CacheSnapshot | null = null;
  let snapshot1d: CacheSnapshot1d | null = null;

  async function load(): Promise<void> {
    const [features1h, features1d] = await Promise.all([
      Promise.all(
        input.symbols.map((symbol) =>
          input.featureStore.fetchLatest({ symbol, exchange: input.exchange, timeframe }),
        ),
      ),
      Promise.all(
        input.symbols.map((symbol) =>
          input.featureStore.fetchLatest({ symbol, exchange: input.exchange, timeframe: "1d" }),
        ),
      ),
    ]);

    const bridged = adaptFeatureSnapshotsToRegimeDetectorInput({
      features1h: features1h.filter((feature): feature is FeatureSnapshot => feature !== null),
      features1d: features1d.filter((feature): feature is FeatureSnapshot => feature !== null),
      now: input.now,
    });
    snapshot = bridged.snapshot;
    snapshot1d = bridged.snapshot1d;
  }

  return {
    cache: {
      async forceRefresh() {
        if (!snapshot) await load();
      },
      read() {
        if (!snapshot) throw new Error("persisted feature cache read before forceRefresh");
        return snapshot;
      },
    },
    cache1d: {
      async forceRefresh() {
        if (!snapshot1d) await load();
      },
      read() {
        if (!snapshot1d) throw new Error("persisted feature 1d cache read before forceRefresh");
        return snapshot1d;
      },
    },
  };
}
