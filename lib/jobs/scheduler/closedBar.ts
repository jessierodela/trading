import type { ScheduledFeedTimeframe } from "./types";

const HOUR_MS = 60 * 60 * 1000;

function toValidDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid timestamp: ${String(value)}`);
  }
  return date;
}

export function canonicalIso(value: Date | string): string {
  return toValidDate(value).toISOString();
}

export function floorToClosedBar(
  now: Date | string = new Date(),
  timeframe: ScheduledFeedTimeframe = "1h",
): string {
  if (timeframe !== "1h") {
    throw new Error(`unsupported scheduled feed timeframe: ${timeframe}`);
  }
  const date = toValidDate(now);
  const currentHour = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    0,
    0,
    0,
  );
  return new Date(currentHour - HOUR_MS).toISOString();
}

export function closedBarDedupeSuffix(closedBarTs: Date | string): string {
  return canonicalIso(closedBarTs);
}

export function closedBarRunAfter(
  closedBarTs: Date | string,
  offsetMinutes: number,
): string {
  if (!Number.isFinite(offsetMinutes) || offsetMinutes < 0) {
    throw new Error("offsetMinutes must be finite and non-negative");
  }
  return new Date(Date.parse(canonicalIso(closedBarTs)) + offsetMinutes * 60_000).toISOString();
}
