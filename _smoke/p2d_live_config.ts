/**
 * Shared pure config helpers for the P2D live capture smoke.
 *
 * Kept separate from features_crossvalidate_live.ts so the offline smoke can
 * test reachability math without importing the DB/network live harness.
 */

export const SAMPLE_BARS = 72;
export const BACKTRACK_BUFFER = 6;
export const DEFAULT_BACKTRACK_CHUNK = 2;

/** Free-tier max backtrack depth (empirically: 270 OK, 290 not). */
export const TAAPI_MAX_BACKTRACK = 270;

export function resolveBacktrackChunk(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const raw = env.P2D_BACKTRACK_CHUNK;
  if (raw === undefined || raw === "") return DEFAULT_BACKTRACK_CHUNK;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`P2D_BACKTRACK_CHUNK must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}

export function requestedBacktrackEnd(
  startOffset: number,
  sampleBars = SAMPLE_BARS,
  buffer = BACKTRACK_BUFFER,
): number {
  return startOffset + sampleBars + buffer - 1;
}

export function isTaapiBacktrackReachable(
  startOffset: number,
  maxBacktrack = TAAPI_MAX_BACKTRACK,
): boolean {
  return requestedBacktrackEnd(startOffset) <= maxBacktrack;
}
