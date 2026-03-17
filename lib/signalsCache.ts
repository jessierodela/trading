/**
 * lib/signalsCache.ts
 *
 * Shared in-memory cache state for /api/signals.
 * Extracted from route.ts so the cache can be invalidated by
 * /api/cache/refresh without exporting a non-route function from route.ts
 * (which breaks Next.js App Router type checking).
 */

export const MEMORY_TTL_MS = 90_000;

export const memCache = {
  response:   null as object | null,
  expiresAt:  0,
};

export function invalidateSignalsCache(): void {
  memCache.response  = null;
  memCache.expiresAt = 0;
  console.log("[signals] L1 cache invalidated — next poll will run GPT-4o");
}