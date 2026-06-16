export type JobPayload =
  | {
      jobType: "market.ingest.latest";
      symbols: string[];
      exchange: string;
      timeframe: "1h" | "1d";
      source: "coinbase" | "polygon";
      closedBarsOnly: true;
    }
  | {
      jobType: "features.compute";
      symbols: string[];
      exchange: string;
      timeframe: "1h" | "1d";
      featureVersion: string;
    }
  | {
      jobType: "regime.compute";
      symbols: string[];
      exchange: string;
      timeframe: "1h" | "1d";
      regimeModelVersion: string;
      source: "persisted_features";
    }
  | {
      jobType: "strategies.evaluate";
      symbols: string[];
      exchange: string;
      timeframe: "1h";
      strategyIds?: string[];
    }
  | {
      jobType: "paper.monitor";
      symbols?: string[];
      exchange?: string;
      timeframe: "1h";
    }
  | {
      jobType: "dashboard.snapshot";
      snapshotType: "dashboard" | "signals" | "regime" | "paper";
      symbols?: string[];
    }
  | {
      jobType: "telegram.refresh";
      chatId: string;
      symbol?: string;
      requestedBy: "telegram";
    };

export type JobType = JobPayload["jobType"];

export const JOB_TYPES: JobType[] = [
  "market.ingest.latest",
  "features.compute",
  "regime.compute",
  "strategies.evaluate",
  "paper.monitor",
  "dashboard.snapshot",
  "telegram.refresh",
];

export const FORBIDDEN_LIVE_JOB_TYPES = [
  "live.execute",
  "broker.submit",
  "exchange.order",
  "order.live",
  "position.live",
] as const;

export type ForbiddenLiveJobType = (typeof FORBIDDEN_LIVE_JOB_TYPES)[number];

const JOB_TYPE_SET = new Set<string>(JOB_TYPES);
const FORBIDDEN_LIVE_JOB_TYPE_SET = new Set<string>(FORBIDDEN_LIVE_JOB_TYPES);

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && JOB_TYPE_SET.has(value);
}

export function isForbiddenLiveJobType(value: unknown): value is ForbiddenLiveJobType {
  return typeof value === "string" && FORBIDDEN_LIVE_JOB_TYPE_SET.has(value);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("job payload must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): void {
  if (typeof obj[key] !== "string" || String(obj[key]).trim().length === 0) {
    throw new Error(`job payload ${key} must be a non-empty string`);
  }
}

function requireStringArray(obj: Record<string, unknown>, key: string): void {
  const value = obj[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((x) => typeof x !== "string" || x.trim().length === 0)) {
    throw new Error(`job payload ${key} must be a non-empty string array`);
  }
}

function optionalStringArray(obj: Record<string, unknown>, key: string): void {
  if (obj[key] === undefined) return;
  const value = obj[key];
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || x.trim().length === 0)) {
    throw new Error(`job payload ${key} must be a string array when provided`);
  }
}

function requireTimeframe(obj: Record<string, unknown>, allowed: readonly string[]): void {
  if (typeof obj.timeframe !== "string" || !allowed.includes(obj.timeframe)) {
    throw new Error(`job payload timeframe must be one of ${allowed.join(", ")}`);
  }
}

export function validateJobPayload(payload: unknown): JobPayload {
  const obj = asObject(payload);
  const jobType = obj.jobType;

  if (isForbiddenLiveJobType(jobType)) {
    throw new Error(`forbidden live execution job type: ${jobType}`);
  }
  if (!isJobType(jobType)) {
    throw new Error(`unknown job type: ${String(jobType)}`);
  }

  switch (jobType) {
    case "market.ingest.latest":
      requireStringArray(obj, "symbols");
      requireString(obj, "exchange");
      requireTimeframe(obj, ["1h", "1d"]);
      if (obj.source !== "coinbase" && obj.source !== "polygon") {
        throw new Error("market.ingest.latest source must be coinbase or polygon");
      }
      if (obj.closedBarsOnly !== true) {
        throw new Error("market.ingest.latest requires closedBarsOnly=true");
      }
      break;
    case "features.compute":
      requireStringArray(obj, "symbols");
      requireString(obj, "exchange");
      requireTimeframe(obj, ["1h", "1d"]);
      requireString(obj, "featureVersion");
      break;
    case "regime.compute":
      requireStringArray(obj, "symbols");
      requireString(obj, "exchange");
      requireTimeframe(obj, ["1h", "1d"]);
      requireString(obj, "regimeModelVersion");
      if (obj.source !== "persisted_features") {
        throw new Error("regime.compute source must be persisted_features");
      }
      break;
    case "strategies.evaluate":
      requireStringArray(obj, "symbols");
      requireString(obj, "exchange");
      requireTimeframe(obj, ["1h"]);
      optionalStringArray(obj, "strategyIds");
      break;
    case "paper.monitor":
      optionalStringArray(obj, "symbols");
      if (obj.exchange !== undefined) requireString(obj, "exchange");
      requireTimeframe(obj, ["1h"]);
      break;
    case "dashboard.snapshot":
      if (!["dashboard", "signals", "regime", "paper"].includes(String(obj.snapshotType))) {
        throw new Error("dashboard.snapshot snapshotType must be dashboard, signals, regime, or paper");
      }
      optionalStringArray(obj, "symbols");
      break;
    case "telegram.refresh":
      requireString(obj, "chatId");
      if (obj.symbol !== undefined) requireString(obj, "symbol");
      if (obj.requestedBy !== "telegram") {
        throw new Error("telegram.refresh requestedBy must be telegram");
      }
      break;
  }

  return payload as JobPayload;
}

export function assertNoLiveExecutionJobTypes(): void {
  const overlap = JOB_TYPES.filter((jobType) => FORBIDDEN_LIVE_JOB_TYPE_SET.has(jobType));
  if (overlap.length > 0) {
    throw new Error(`live execution job types are not allowed: ${overlap.join(", ")}`);
  }
}
