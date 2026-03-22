/**
 * lib/signalsCache.ts
 *
 * In-memory cache for the last signal run.
 * Written by POST /api/cache/refresh, read by GET /api/signals.
 */

export const MEMORY_TTL_MS = 90_000;

export const memCache = {
  response:  null as object | null,
  expiresAt: 0,
};
