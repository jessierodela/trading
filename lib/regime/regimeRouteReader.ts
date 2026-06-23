import type {
  DashboardSnapshotFilter,
  DashboardSnapshotRecord,
} from "@/lib/jobs/dashboardSnapshotStore";
import { mapRegimeToPermission, type RegimeLabel } from "@/lib/regime/permissionMap";
import type { Exchange } from "@/lib/quant/types";
import type { RegimeSnapshotRow, RegimeStore } from "@/lib/storage/interfaces";

type RouteRegimeSource = "regime_snapshots" | "dashboard_snapshots" | "memCache" | "empty";

export interface RegimeRouteSuccess {
  success: true;
  symbol: string;
  regime: RegimeLabel;
  reliability: number;
  directionalBias: string;
  tradePermission: string;
  edgeMultiplier: number;
  sizeMultiplier: number;
  emaContext: unknown;
  volContext: unknown;
  reason: string;
  updatedAt: string | null;
}

export interface RegimeRouteFailure {
  success: false;
  error: string;
  symbol: string;
  supportedSymbols?: string[];
}

export type RegimeRouteResponse = RegimeRouteSuccess | RegimeRouteFailure;

export interface RegimeRouteReadResult {
  source: RouteRegimeSource;
  status: number;
  body: RegimeRouteResponse;
}

export interface DashboardSnapshotReader {
  fetchLatestSnapshot(filter: DashboardSnapshotFilter): Promise<DashboardSnapshotRecord | null>;
}

const REGIME_LABELS: RegimeLabel[] = [
  "TREND_UP",
  "TREND_DOWN",
  "LOW_VOL",
  "HIGH_VOL",
  "CHOP",
  "NEWS_SHOCK",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRegimeLabel(value: unknown): value is RegimeLabel {
  return typeof value === "string" && REGIME_LABELS.includes(value as RegimeLabel);
}

function normalizePlainSymbol(value: string): string {
  return value.trim().toUpperCase().replace("/", "-");
}

export function normalizeRegimeRouteSymbol(symbol: string): {
  requestedSymbol: string;
  persistedSymbol: string;
  persistedCandidates: string[];
  dashboardCandidates: string[];
} {
  const requestedSymbol = normalizePlainSymbol(symbol || "BTC");
  const persistedSymbol = requestedSymbol.endsWith("-USDT")
    ? `${requestedSymbol.slice(0, -5)}-USD`
    : requestedSymbol.endsWith("-USD")
      ? requestedSymbol
      : `${requestedSymbol}-USD`;
  const base = persistedSymbol.replace(/-USD$/, "");
  const dashboardCandidates = [
    requestedSymbol,
    persistedSymbol,
    base,
    `${base}-USDT`,
    `${base}/USDT`,
  ];
  const persistedCandidates = [persistedSymbol, requestedSymbol, base];

  return {
    requestedSymbol,
    persistedSymbol,
    persistedCandidates: [...new Set(persistedCandidates)],
    dashboardCandidates: [...new Set(dashboardCandidates)],
  };
}

function extractContext(rawResponse: unknown): { emaContext: unknown; volContext: unknown } {
  if (!isRecord(rawResponse)) return { emaContext: null, volContext: null };
  const signal = isRecord(rawResponse.signal) ? rawResponse.signal : null;
  const body = isRecord(rawResponse.body) ? rawResponse.body : null;
  return {
    emaContext: signal?.emaContext ?? body?.emaContext ?? rawResponse.emaContext ?? null,
    volContext: signal?.volContext ?? body?.volContext ?? rawResponse.volContext ?? null,
  };
}

function responseFromRegimeSnapshot(
  row: RegimeSnapshotRow,
  requestedSymbol: string,
): RegimeRouteSuccess {
  const context = extractContext(row.rawResponse);
  const fallbackMapping = mapRegimeToPermission(row.regime, row.reliability);
  return {
    success: true,
    symbol: requestedSymbol,
    regime: row.regime,
    reliability: row.reliability,
    directionalBias: row.directionalBias,
    tradePermission: row.tradePermission,
    edgeMultiplier: row.edgeMultiplier,
    sizeMultiplier: row.sizeMultiplier,
    emaContext: context.emaContext,
    volContext: context.volContext,
    reason: row.reason ?? fallbackMapping.reason,
    updatedAt: row.ts,
  };
}

function regimeMapFromPayload(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !isRecord(payload.regimeMap)) return null;
  return payload.regimeMap;
}

function findRegimeMapEntry(
  regimeMap: Record<string, unknown>,
  candidates: string[],
): { key: string; value: Record<string, unknown> } | null {
  for (const candidate of candidates) {
    const exact = regimeMap[candidate];
    if (isRecord(exact)) return { key: candidate, value: exact };
  }

  const upperCandidates = new Set(candidates.map((candidate) => candidate.toUpperCase()));
  for (const [key, value] of Object.entries(regimeMap)) {
    if (upperCandidates.has(key.toUpperCase()) && isRecord(value)) {
      return { key, value };
    }
  }

  return null;
}

function responseFromDashboardPayload(input: {
  payload: unknown;
  requestedSymbol: string;
  dashboardCandidates: string[];
  generatedAt?: string | null;
}): RegimeRouteSuccess | null {
  const regimeMap = regimeMapFromPayload(input.payload);
  if (!regimeMap) return null;

  const found = findRegimeMapEntry(regimeMap, input.dashboardCandidates);
  if (!found) return null;

  const regime = found.value.regime;
  const reliability = found.value.reliability;
  if (!isRegimeLabel(regime) || typeof reliability !== "number") return null;

  const mapped = mapRegimeToPermission(regime, reliability);
  const payloadGeneratedAt = isRecord(input.payload) && typeof input.payload.generatedAt === "string"
    ? input.payload.generatedAt
    : null;

  return {
    success: true,
    symbol: input.requestedSymbol,
    regime,
    reliability,
    directionalBias: mapped.directionalBias,
    tradePermission: mapped.tradePermission,
    edgeMultiplier: mapped.edgeMultiplier,
    sizeMultiplier: mapped.sizeMultiplier,
    emaContext: found.value.emaContext ?? null,
    volContext: found.value.volContext ?? null,
    reason: mapped.reason,
    updatedAt: input.generatedAt ?? payloadGeneratedAt,
  };
}

function emptyResponse(symbol: string, supportedSymbols?: string[]): RegimeRouteReadResult {
  return {
    source: "empty",
    status: 404,
    body: {
      success: false,
      error: supportedSymbols && supportedSymbols.length > 0
        ? `No regime data for symbol ${symbol}. Supported symbols are: ${supportedSymbols.join(", ")}.`
        : "Regime data is empty. Queue a dashboard refresh and wait for completion first.",
      symbol,
      ...(supportedSymbols && supportedSymbols.length > 0 ? { supportedSymbols } : {}),
    },
  };
}

export async function readRegimeRouteState(input: {
  symbol: string;
  exchange?: Exchange;
  regimeStore?: Pick<RegimeStore, "latest"> | null;
  dashboardSnapshotStore?: DashboardSnapshotReader | null;
  memoryResponse?: object | null;
  onPersistedReadError?: (error: unknown) => void;
}): Promise<RegimeRouteReadResult> {
  const exchange = input.exchange ?? "COINBASE";
  const lookup = normalizeRegimeRouteSymbol(input.symbol);

  if (input.regimeStore) {
    try {
      for (const candidate of lookup.persistedCandidates) {
        const latest = await input.regimeStore.latest({ symbol: candidate, exchange });
        if (latest) {
          return {
            source: "regime_snapshots",
            status: 200,
            body: responseFromRegimeSnapshot(latest, lookup.requestedSymbol),
          };
        }
      }
    } catch (err) {
      input.onPersistedReadError?.(err);
    }
  }

  let supportedSymbols: string[] | undefined;
  if (input.dashboardSnapshotStore) {
    try {
      const snapshot = await input.dashboardSnapshotStore.fetchLatestSnapshot({
        snapshotType: "dashboard",
        includeExpired: false,
      });
      const regimeMap = snapshot ? regimeMapFromPayload(snapshot.payload) : null;
      if (regimeMap) supportedSymbols = Object.keys(regimeMap).sort((a, b) => a.localeCompare(b));
      if (snapshot) {
        const response = responseFromDashboardPayload({
          payload: snapshot.payload,
          requestedSymbol: lookup.requestedSymbol,
          dashboardCandidates: lookup.dashboardCandidates,
          generatedAt: snapshot.generatedAt,
        });
        if (response) {
          return {
            source: "dashboard_snapshots",
            status: 200,
            body: response,
          };
        }
      }
    } catch (err) {
      input.onPersistedReadError?.(err);
    }
  }

  const memoryRegimeMap = regimeMapFromPayload(input.memoryResponse);
  if (memoryRegimeMap) {
    supportedSymbols = supportedSymbols ?? Object.keys(memoryRegimeMap).sort((a, b) => a.localeCompare(b));
    const response = responseFromDashboardPayload({
      payload: input.memoryResponse,
      requestedSymbol: lookup.requestedSymbol,
      dashboardCandidates: lookup.dashboardCandidates,
    });
    if (response) {
      return {
        source: "memCache",
        status: 200,
        body: response,
      };
    }
  }

  return emptyResponse(lookup.requestedSymbol, supportedSymbols);
}
