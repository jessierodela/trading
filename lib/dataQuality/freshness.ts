import type { Timeframe } from "@/lib/quant/types";

export const TIMEFRAME_MS: Record<Extract<Timeframe, "1h" | "1d">, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

export const DEFAULT_1H_MAX_STALENESS_BARS = 2;
export const DEFAULT_1D_MAX_STALENESS_BARS = 2;

function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function maxStalenessBarsFor(timeframe: Extract<Timeframe, "1h" | "1d">): number {
  if (timeframe === "1h") {
    return envPositiveInteger("DATA_QUALITY_1H_MAX_STALENESS_BARS", DEFAULT_1H_MAX_STALENESS_BARS);
  }
  return envPositiveInteger("DATA_QUALITY_1D_MAX_STALENESS_BARS", DEFAULT_1D_MAX_STALENESS_BARS);
}

export function floorToTimeframe(date: Date, timeframe: Extract<Timeframe, "1h" | "1d">): Date {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  if (timeframe === "1d") d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function latestClosedBarOpen(now: Date, timeframe: Extract<Timeframe, "1h" | "1d">): string {
  return new Date(floorToTimeframe(now, timeframe).getTime() - TIMEFRAME_MS[timeframe]).toISOString();
}

export function isValidIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isAlignedToTimeframe(ts: string, timeframe: Extract<Timeframe, "1h" | "1d">): boolean {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return false;
  if (timeframe === "1d") {
    const d = new Date(parsed);
    return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  }
  const d = new Date(parsed);
  return d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

export function isClosedBarOpen(
  ts: string,
  timeframe: Extract<Timeframe, "1h" | "1d">,
  now: Date,
): boolean {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return false;
  return parsed + TIMEFRAME_MS[timeframe] <= floorToTimeframe(now, timeframe).getTime();
}

export function closedBarAge(
  ts: string,
  timeframe: Extract<Timeframe, "1h" | "1d">,
  now: Date,
): number | null {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return null;
  const latest = Date.parse(latestClosedBarOpen(now, timeframe));
  if (!Number.isFinite(latest)) return null;
  return Math.floor((latest - parsed) / TIMEFRAME_MS[timeframe]);
}
