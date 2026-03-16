/**
 * config/polling.ts
 *
 * Single source of truth for all API poll intervals.
 * All client components and the signals route read from here.
 *
 * TAAPI free plan math:
 *   indicators per asset × 15.5s + retry buffer = ~75s worst case.
 *   SIGNALS_CACHE_TTL_MS must exceed this so the cache never expires
 *   mid-fetch and triggers an overlapping cycle.
 *
 * Rule: no poll interval should be shorter than SIGNALS_CACHE_TTL_MS.
 */

/** How long the server caches /api/signals results (ms) */
export const SIGNALS_CACHE_TTL_MS = 90_000;

/** How often client components poll /api/signals (ms) — must match TTL */
export const SIGNALS_POLL_MS = 90_000;

/** How often the watchlist polls /api/market for live prices (ms) */
export const MARKET_POLL_MS = 90_000;
