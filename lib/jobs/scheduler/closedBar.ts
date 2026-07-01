import type { Timeframe } from "@/lib/quant/types";

/**
 * Closed-bar timeframes this helper knows how to floor. Broader than
 * ScheduledFeedTimeframe (which stays "1h"-only for the main scheduled feed
 * config) — the daily-context stages need "1d" here without widening the
 * main feed's timeframe knob.
 */
export type ClosedBarTimeframe = Extract<Timeframe, "1h" | "1d">;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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
  timeframe: ClosedBarTimeframe = "1h",
): string {
  const date = toValidDate(now);
  if (timeframe === "1h") {
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
  if (timeframe === "1d") {
    const currentDay = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0,
      0,
    );
    return new Date(currentDay - DAY_MS).toISOString();
  }
  throw new Error(`unsupported closed bar timeframe: ${timeframe}`);
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
