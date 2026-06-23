import type { JobPayload } from "@/lib/jobs/types";
import type { PaperPosition, PaperPositionBar } from "@/lib/execution";
import { updatePaperPositionWithBar } from "@/lib/execution";
import type { Bar } from "@/lib/quant/types";
import {
  handlerSuccess,
  invalidPayload,
  requireService,
  retryableFailure,
  type JobHandler,
} from "./types";

type PaperPayload = Extract<JobPayload, { jobType: "paper.monitor" }>;

const ALLOWED_EXCHANGES = new Set(["COINBASE", "BINANCE", "POLYGON"]);
const DEFAULT_SLIPPAGE_BPS = 10;
const DEFAULT_FEE_BPS = 5;

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase().replace("/", "-");
}

function readNonNegativeBps(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${envKey} must be finite and non-negative`);
  }
  return value;
}

function groupKey(symbol: string, exchange: string): string {
  return `${symbol}|${exchange}`;
}

function toPaperBar(bar: Bar): PaperPositionBar {
  return {
    symbol: bar.symbol,
    exchange: bar.exchange,
    ts: bar.ts,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  };
}

function groupPositions(positions: PaperPosition[]): Map<string, PaperPosition[]> {
  const groups = new Map<string, PaperPosition[]>();
  for (const position of positions) {
    const key = groupKey(position.symbol, position.exchange);
    groups.set(key, [...(groups.get(key) ?? []), position]);
  }
  return groups;
}

export const handlePaperMonitor: JobHandler<PaperPayload> = async (payload, context) => {
  if (payload.exchange && !ALLOWED_EXCHANGES.has(payload.exchange.toUpperCase())) {
    return invalidPayload("paper.monitor exchange must be COINBASE, BINANCE, or POLYGON", {
      exchange: payload.exchange,
    });
  }

  let slippageBps: number;
  let feeBps: number;
  try {
    slippageBps = readNonNegativeBps("PAPER_TRADING_SLIPPAGE_BPS", DEFAULT_SLIPPAGE_BPS);
    feeBps = readNonNegativeBps("PAPER_TRADING_FEE_BPS", DEFAULT_FEE_BPS);
  } catch (err) {
    return invalidPayload(err instanceof Error ? err.message : String(err));
  }

  const paperStore = requireService(context.services, "paperStore");
  const barStore = requireService(context.services, "barStore");
  const symbolSet = payload.symbols
    ? new Set(payload.symbols.map(normalizeSymbol))
    : null;
  const exchange = payload.exchange?.toUpperCase();

  const openPositions = await paperStore.listPositions({ status: "open" });
  const matchingPositions = openPositions.filter((position) => {
    if (position.timeframe !== payload.timeframe) return false;
    if (symbolSet && !symbolSet.has(normalizeSymbol(position.symbol))) return false;
    if (exchange && position.exchange.toUpperCase() !== exchange) return false;
    return true;
  });

  if (matchingPositions.length === 0) {
    return handlerSuccess({
      paperOnly: true,
      evaluatedAt: context.now().toISOString(),
      openPositions: openPositions.length,
      matchedPositions: 0,
      updatedPositions: 0,
      closedPositions: 0,
      skippedPositions: openPositions.length,
      groups: [],
    });
  }

  const groups = groupPositions(matchingPositions);
  const bars = new Map<string, PaperPositionBar>();
  for (const [key, positions] of groups.entries()) {
    if (context.signal?.aborted) {
      return retryableFailure("paper_monitor_aborted", { key });
    }
    const [symbol, positionExchange] = key.split("|");
    const recent = await barStore.fetchRecent({
      symbol,
      exchange: positionExchange as PaperPositionBar["exchange"],
      timeframe: payload.timeframe,
    }, 1);
    const latest = recent.at(-1);
    if (!latest) {
      return retryableFailure("paper_monitor_bar_unavailable", {
        symbol,
        exchange: positionExchange,
        timeframe: payload.timeframe,
        positionIds: positions.map((position) => position.id ?? null),
      });
    }
    bars.set(key, toPaperBar(latest));
  }

  const updatedPositions: PaperPosition[] = [];
  const groupSummaries: Array<{
    symbol: string;
    exchange: string;
    evaluatedAt: string;
    positions: number;
    closedPositions: number;
  }> = [];

  for (const [key, positions] of groups.entries()) {
    const bar = bars.get(key);
    if (!bar) continue;
    for (const position of positions) {
      const updated = updatePaperPositionWithBar(position, bar, {
        slippageBps,
        feeBps,
        stopFirst: true,
      });
      updatedPositions.push(await paperStore.updatePosition(updated));
    }
    const [symbol, positionExchange] = key.split("|");
    groupSummaries.push({
      symbol,
      exchange: positionExchange,
      evaluatedAt: bar.ts,
      positions: positions.length,
      closedPositions: updatedPositions.filter((position) => (
        position.symbol === symbol &&
        position.exchange === positionExchange &&
        position.status === "closed"
      )).length,
    });
  }

  const closedPositions = updatedPositions.filter((position) => position.status === "closed");
  return handlerSuccess({
    paperOnly: true,
    evaluatedAt: context.now().toISOString(),
    openPositions: openPositions.length,
    matchedPositions: matchingPositions.length,
    updatedPositions: updatedPositions.length,
    closedPositions: closedPositions.length,
    skippedPositions: openPositions.length - matchingPositions.length,
    slippageBps,
    feeBps,
    groups: groupSummaries,
  });
};
