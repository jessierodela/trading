/**
 * config/polling.ts
 *
 * Single source of truth for all API poll intervals.
 *
 * Cache architecture:
 *  - Indicator cache auto-refreshes every 5 minutes (server-side timer)
 *  - /api/signals response is cached for 90s (avoids re-running GPT-4o per poll)
 *  - Client polls /api/signals every 90s
 *  - Manual refresh available via POST /api/cache/refresh
 *
 * TAAPI free plan math:
 *   indicators per asset × 15.5s + retry buffer ≈ 75s worst case per asset.
 *   With 5 assets, total fetch time can exceed 5 min — consider upgrading
 *   to a paid taapi plan or reducing symbol count if fetches overlap.
 */

/** How long the /api/signals response is cached server-side (ms) */
export const SIGNALS_CACHE_TTL_MS = 90_000;

/** How often client components poll /api/signals (ms) */
export const SIGNALS_POLL_MS = 90_000;

/** How often the watchlist polls /api/market for live prices (ms) */
export const MARKET_POLL_MS = 90_000;

/** How often the indicator cache auto-refreshes (ms) — server-side only */
export const INDICATOR_CACHE_REFRESH_MS = 5 * 60 * 1000; // 5 minutes