import { getPgPool, withPooledClient } from "@/lib/storage";
import { PostgresTradeIntentStore, type TradeIntent, type TradeIntentStore } from "@/lib/tradeIntent";
import { createPaperOrder } from "./orderManager";
import { openPaperPosition, updatePaperPositionWithBar } from "./paperPosition";
import { PostgresPaperTradingStore } from "./postgresPaperTradingStore";
import { simulatePaperFill } from "./fillSimulator";
import type {
  PaperFill,
  PaperOrder,
  PaperOrderType,
  PaperPosition,
  PaperPositionBar,
  PaperPositionStatus,
} from "./types";
import type { PaperTradingStore } from "./storeTypes";

export interface PaperTradingApiContext {
  intentStore: TradeIntentStore;
  paperStore: PaperTradingStore;
  env?: Record<string, string | undefined>;
}

export interface PaperApiResult<T> {
  status: number;
  body: T;
}

export interface PaperApiError {
  ok: false;
  paperOnly: true;
  error: string;
  stage?: string;
}

export interface CreatePaperOrderBody {
  tradeIntentId?: unknown;
  requestedPrice?: unknown;
  slippageBps?: unknown;
  feeBps?: unknown;
  orderType?: unknown;
  nowTs?: unknown;
}

export interface FillPaperOrderBody {
  orderId?: unknown;
  fillTs?: unknown;
}

export interface OpenFromFillBody {
  action: "open_from_fill";
  tradeIntentId?: unknown;
  orderId?: unknown;
}

export interface UpdateWithBarBody {
  action: "update_with_bar";
  positionId?: unknown;
  bar?: unknown;
  slippageBps?: unknown;
  feeBps?: unknown;
}

export interface ManualCloseBody {
  action: "manual_close";
  positionId?: unknown;
  manualClosePrice?: unknown;
  manualCloseTs?: unknown;
  slippageBps?: unknown;
  feeBps?: unknown;
}

export type PaperPositionBody = Record<string, unknown>;

export interface ListPositionsQuery {
  status?: string | null;
  symbol?: string | null;
  limit?: string | null;
}

export interface PaperPositionSummary {
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalFees: number;
  openCount: number;
  closedCount: number;
}

function error(status: number, message: string, stage?: string): PaperApiResult<PaperApiError> {
  return {
    status,
    body: {
      ok: false,
      paperOnly: true,
      error: message,
      ...(stage ? { stage } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string when provided`);
  }
  return value;
}

function numberField(body: Record<string, unknown>, key: string, minimum: number): number | null {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) return null;
  return value;
}

function parseNonNegativeNumber(body: Record<string, unknown>, key: string): number | null {
  return numberField(body, key, 0);
}

function parsePositiveNumber(body: Record<string, unknown>, key: string): number | null {
  return numberField(body, key, Number.MIN_VALUE);
}

function parseTimestamp(value: string | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${key} must be a valid timestamp`);
  return value;
}

function parseOrderType(value: unknown): PaperOrderType | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "market" || value === "limit") return value;
  throw new Error("orderType must be market or limit");
}

function parsePaperBar(value: unknown): PaperPositionBar | null {
  if (!isRecord(value)) return null;
  const symbol = stringField(value, "symbol");
  const exchange = stringField(value, "exchange");
  const ts = stringField(value, "ts");
  const open = parsePositiveNumber(value, "open");
  const high = parsePositiveNumber(value, "high");
  const low = parsePositiveNumber(value, "low");
  const close = parsePositiveNumber(value, "close");
  if (!symbol || !exchange || !ts || open === null || high === null || low === null || close === null) return null;
  if (!Number.isFinite(Date.parse(ts))) return null;
  if (high < low || high < open || high < close || low > open || low > close) return null;
  return {
    symbol,
    exchange: exchange as PaperPositionBar["exchange"],
    ts,
    open,
    high,
    low,
    close,
  };
}

export function paperTradingAuthResult(
  headers: Pick<Headers, "get">,
  env: Record<string, string | undefined> = process.env,
): PaperApiResult<PaperApiError> | null {
  const configured = env.PAPER_TRADING_API_KEY;
  if (!configured) return error(503, "PAPER_TRADING_API_KEY not configured");
  if (headers.get("x-internal-api-key") !== configured) return error(401, "unauthorized");
  return null;
}

export function isPaperTradingKillSwitchActive(env: Record<string, string | undefined> = process.env): boolean {
  return env.PAPER_TRADING_KILL_SWITCH === "true" || env.PAPER_TRADING_KILL_SWITCH_ENABLED === "true";
}

function validateApprovedIntent(intent: TradeIntent, env: Record<string, string | undefined> | undefined): PaperApiResult<PaperApiError> | null {
  if (intent.status !== "risk_approved") {
    return error(422, "trade intent is not risk_approved", "trade_intent");
  }
  if (intent.riskDecision.approved !== true) {
    return error(422, "trade intent risk decision is not approved", "risk");
  }
  if (intent.riskDecision.riskVersion.trim().length === 0) {
    return error(422, "trade intent riskVersion is missing", "risk");
  }
  if (!Number.isFinite(intent.suggestedSize) || intent.suggestedSize <= 0) {
    return error(422, "trade intent suggestedSize must be positive", "risk");
  }
  if (isPaperTradingKillSwitchActive(env ?? process.env)) {
    return error(423, "paper trading kill switch is active", "kill_switch");
  }
  return null;
}

function withPaperOnlyResponse<T extends Record<string, unknown>>(body: T): T & { paperOnly: true } {
  return { ...body, paperOnly: true };
}

export async function createPaperOrderFromIntent(
  ctx: PaperTradingApiContext,
  body: CreatePaperOrderBody,
): Promise<PaperApiResult<{ ok: true; paperOnly: true; order: PaperOrder } | PaperApiError>> {
  if (!isRecord(body)) return error(400, "request body must be an object");
  const tradeIntentId = stringField(body, "tradeIntentId");
  const requestedPrice = parsePositiveNumber(body, "requestedPrice");
  const slippageBps = parseNonNegativeNumber(body, "slippageBps");
  const feeBps = parseNonNegativeNumber(body, "feeBps");
  let orderType: PaperOrderType | undefined;
  let nowTs: string | undefined;
  try {
    orderType = parseOrderType(body.orderType);
    nowTs = parseTimestamp(optionalStringField(body, "nowTs"), "nowTs");
  } catch (err) {
    return error(400, err instanceof Error ? err.message : String(err));
  }
  if (!tradeIntentId) return error(400, "tradeIntentId is required");
  if (requestedPrice === null) return error(400, "requestedPrice must be a positive number");
  if (slippageBps === null) return error(400, "slippageBps must be a non-negative number");
  if (feeBps === null) return error(400, "feeBps must be a non-negative number");

  const intent = await ctx.intentStore.fetchIntent(tradeIntentId);
  if (!intent) return error(404, "trade intent not found", "trade_intent");
  const validation = validateApprovedIntent(intent, ctx.env);
  if (validation) return validation;

  const requestedIntent: TradeIntent = {
    ...intent,
    entryPrice: requestedPrice,
    metadata: {
      ...structuredClone(intent.metadata),
      paperApiRequestedPrice: requestedPrice,
    },
  };
  const order = await ctx.paperStore.insertOrder(createPaperOrder(requestedIntent, {
    slippageBps,
    feeBps,
    orderType,
    nowTs,
    killSwitchEnabled: false,
  }));
  return {
    status: 201,
    body: withPaperOnlyResponse({ ok: true as const, order }),
  };
}

export async function fillPaperOrder(
  ctx: PaperTradingApiContext,
  body: FillPaperOrderBody,
): Promise<PaperApiResult<{ ok: true; paperOnly: true; order: PaperOrder; fill: PaperFill } | PaperApiError>> {
  if (!isRecord(body)) return error(400, "request body must be an object");
  const orderId = stringField(body, "orderId");
  const fillTs = stringField(body, "fillTs");
  if (!orderId) return error(400, "orderId is required");
  if (!fillTs || !Number.isFinite(Date.parse(fillTs))) return error(400, "fillTs must be a valid timestamp");

  const order = await ctx.paperStore.fetchOrder(orderId);
  if (!order) return error(404, "paper order not found", "order");
  if (order.status !== "accepted") {
    return error(422, `paper order must be accepted before fill: ${order.status}`, "order");
  }

  const fill = await ctx.paperStore.insertFill(simulatePaperFill(order, fillTs));
  const filledOrder = await ctx.paperStore.updateOrder({
    ...order,
    status: "filled",
    reason: "PAPER_ORDER_FILLED",
    filledAt: fill.ts,
    fillPrice: fill.fillPrice,
  });
  return {
    status: 200,
    body: withPaperOnlyResponse({ ok: true as const, order: filledOrder, fill }),
  };
}

export async function mutatePaperPosition(
  ctx: PaperTradingApiContext,
  body: PaperPositionBody,
): Promise<PaperApiResult<{ ok: true; paperOnly: true; position: PaperPosition } | PaperApiError>> {
  if (!isRecord(body)) return error(400, "request body must be an object");
  if (body.action === "open_from_fill") return openPositionFromFill(ctx, body);
  if (body.action === "update_with_bar") return updatePositionWithBar(ctx, body);
  if (body.action === "manual_close") return closePositionManually(ctx, body);
  return error(400, "action must be open_from_fill, update_with_bar, or manual_close");
}

async function openPositionFromFill(
  ctx: PaperTradingApiContext,
  body: Record<string, unknown>,
): Promise<PaperApiResult<{ ok: true; paperOnly: true; position: PaperPosition } | PaperApiError>> {
  const tradeIntentId = stringField(body, "tradeIntentId");
  const orderId = stringField(body, "orderId");
  if (!tradeIntentId) return error(400, "tradeIntentId is required");
  if (!orderId) return error(400, "orderId is required");

  const [intent, order, fill] = await Promise.all([
    ctx.intentStore.fetchIntent(tradeIntentId),
    ctx.paperStore.fetchOrder(orderId),
    ctx.paperStore.fetchFill(orderId),
  ]);
  if (!intent) return error(404, "trade intent not found", "trade_intent");
  if (!order) return error(404, "paper order not found", "order");
  if (!fill) return error(404, "paper fill not found", "fill");
  if (order.status !== "filled") return error(422, "paper order must be filled before opening a position", "order");

  const position = await ctx.paperStore.insertPosition(openPaperPosition(intent, order, fill));
  return {
    status: 201,
    body: withPaperOnlyResponse({ ok: true as const, position }),
  };
}

async function updatePositionWithBar(
  ctx: PaperTradingApiContext,
  body: Record<string, unknown>,
): Promise<PaperApiResult<{ ok: true; paperOnly: true; position: PaperPosition } | PaperApiError>> {
  const positionId = stringField(body, "positionId");
  const bar = parsePaperBar(body.bar);
  const slippageBps = parseNonNegativeNumber(body, "slippageBps");
  const feeBps = parseNonNegativeNumber(body, "feeBps");
  if (!positionId) return error(400, "positionId is required");
  if (!bar) return error(400, "bar must include valid symbol, exchange, ts, open, high, low, close");
  if (slippageBps === null) return error(400, "slippageBps must be a non-negative number");
  if (feeBps === null) return error(400, "feeBps must be a non-negative number");

  const position = await ctx.paperStore.fetchPosition(positionId);
  if (!position) return error(404, "paper position not found", "position");
  const updated = await ctx.paperStore.updatePosition(updatePaperPositionWithBar(position, bar, {
    slippageBps,
    feeBps,
  }));
  return {
    status: 200,
    body: withPaperOnlyResponse({ ok: true as const, position: updated }),
  };
}

async function closePositionManually(
  ctx: PaperTradingApiContext,
  body: Record<string, unknown>,
): Promise<PaperApiResult<{ ok: true; paperOnly: true; position: PaperPosition } | PaperApiError>> {
  const positionId = stringField(body, "positionId");
  const manualClosePrice = parsePositiveNumber(body, "manualClosePrice");
  const manualCloseTs = stringField(body, "manualCloseTs");
  const slippageBps = parseNonNegativeNumber(body, "slippageBps");
  const feeBps = parseNonNegativeNumber(body, "feeBps");
  if (!positionId) return error(400, "positionId is required");
  if (manualClosePrice === null) return error(400, "manualClosePrice must be a positive number");
  if (!manualCloseTs || !Number.isFinite(Date.parse(manualCloseTs))) {
    return error(400, "manualCloseTs must be a valid timestamp");
  }
  if (slippageBps === null) return error(400, "slippageBps must be a non-negative number");
  if (feeBps === null) return error(400, "feeBps must be a non-negative number");

  const position = await ctx.paperStore.fetchPosition(positionId);
  if (!position) return error(404, "paper position not found", "position");
  const bar: PaperPositionBar = {
    symbol: position.symbol,
    exchange: position.exchange as PaperPositionBar["exchange"],
    ts: manualCloseTs,
    open: manualClosePrice,
    high: manualClosePrice,
    low: manualClosePrice,
    close: manualClosePrice,
  };
  const updated = await ctx.paperStore.updatePosition(updatePaperPositionWithBar(position, bar, {
    slippageBps,
    feeBps,
    manualClosePrice,
    manualCloseTs,
  }));
  return {
    status: 200,
    body: withPaperOnlyResponse({ ok: true as const, position: updated }),
  };
}

function parseStatusFilter(status: string | null | undefined): PaperPositionStatus | undefined | "invalid" {
  if (status === undefined || status === null || status.trim().length === 0) return undefined;
  if (status === "open" || status === "closed") return status;
  return "invalid";
}

function applyLimit<T>(rows: T[], limit: string | null | undefined): T[] {
  if (limit === undefined || limit === null || limit.trim().length === 0) return rows;
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("limit must be a positive integer");
  return rows.slice(0, parsed);
}

function summarizePositions(openPositions: PaperPosition[], closedPositions: PaperPosition[]): PaperPositionSummary {
  return {
    totalRealizedPnl: closedPositions.reduce((sum, position) => sum + (position.realizedPnl ?? 0), 0),
    totalUnrealizedPnl: openPositions.reduce((sum, position) => sum + position.unrealizedPnl, 0),
    totalFees: [...openPositions, ...closedPositions].reduce((sum, position) => sum + position.fees, 0),
    openCount: openPositions.length,
    closedCount: closedPositions.length,
  };
}

export async function listPaperPositions(
  ctx: PaperTradingApiContext,
  query: ListPositionsQuery,
): Promise<PaperApiResult<{
  ok: true;
  paperOnly: true;
  openPositions: PaperPosition[];
  closedPositions: PaperPosition[];
  summary: PaperPositionSummary;
} | PaperApiError>> {
  const status = parseStatusFilter(query.status);
  if (status === "invalid") return error(400, "status must be open or closed");
  const symbol = query.symbol && query.symbol.trim().length > 0 ? query.symbol : undefined;
  try {
    const openPositions = status === "closed"
      ? []
      : applyLimit(await ctx.paperStore.listPositions({ status: "open", symbol }), query.limit);
    const closedPositions = status === "open"
      ? []
      : applyLimit(await ctx.paperStore.listPositions({ status: "closed", symbol }), query.limit);
    return {
      status: 200,
      body: withPaperOnlyResponse({
        ok: true as const,
        openPositions,
        closedPositions,
        summary: summarizePositions(openPositions, closedPositions),
      }),
    };
  } catch (err) {
    return error(400, err instanceof Error ? err.message : String(err));
  }
}

export async function withPostgresPaperTradingContext<T>(
  fn: (ctx: PaperTradingApiContext) => Promise<T>,
): Promise<T> {
  return withPooledClient(getPgPool(), async (client) => {
    try {
      await client.query("begin");
      const result = await fn({
        intentStore: new PostgresTradeIntentStore(client),
        paperStore: new PostgresPaperTradingStore(client),
        env: process.env,
      });
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    }
  });
}
