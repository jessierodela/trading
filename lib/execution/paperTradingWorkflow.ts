import { evaluateRisk } from "@/lib/risk/riskEngine";
import type { PnlSnapshot, Position, RegimeContext, RiskConfig, RiskDecision, StrategySignal } from "@/lib/risk/types";
import { createTradeIntent, type TradeIntent, type TradeIntentStore } from "@/lib/tradeIntent";
import { simulatePaperFill } from "./fillSimulator";
import { createPaperOrder } from "./orderManager";
import { openPaperPosition, updatePaperPositionWithBar } from "./paperPosition";
import type { PaperTradingStore } from "./storeTypes";
import type {
  PaperFill,
  PaperOrder,
  PaperOrderType,
  PaperPosition,
  PaperPositionBar,
} from "./types";

export interface PaperTradingWorkflowStores {
  intentStore: TradeIntentStore;
  paperStore: PaperTradingStore;
}

export interface PaperTradingCostConfig {
  slippageBps: number;
  feeBps: number;
}

export interface CreatePaperTradeFromSignalInput extends PaperTradingCostConfig {
  stores: PaperTradingWorkflowStores;
  signal: StrategySignal;
  regime: RegimeContext;
  accountEquity: number;
  riskConfig: RiskConfig;
  openRiskPositions?: Position[];
  recentPnL?: PnlSnapshot[];
  sourceSignalIds?: string[];
  entryPrice?: number;
  entryLogic?: string;
  metadata?: Record<string, unknown>;
  orderType?: PaperOrderType;
  nowTs?: string;
  expiresAt?: string | null;
  fillTs?: string;
}

export interface PaperTradeWorkflowResult {
  ok: boolean;
  paperOnly: true;
  stage: "risk_rejected" | "paper_order_rejected" | "position_opened";
  riskDecision: RiskDecision;
  tradeIntent: TradeIntent;
  order: PaperOrder | null;
  fill: PaperFill | null;
  position: PaperPosition | null;
}

export interface MonitorPaperPositionsInput extends PaperTradingCostConfig {
  stores: Pick<PaperTradingWorkflowStores, "paperStore">;
  bar: PaperPositionBar;
  stopFirst?: true;
}

export interface MonitorPaperPositionsResult {
  paperOnly: true;
  evaluatedAt: string;
  updatedPositions: PaperPosition[];
  closedPositions: PaperPosition[];
  skippedPositions: PaperPosition[];
}

export interface ClosePaperPositionManuallyInput extends PaperTradingCostConfig {
  stores: Pick<PaperTradingWorkflowStores, "paperStore">;
  positionId: string;
  manualClosePrice: number;
  manualCloseTs: string;
}

function assertNonNegativeCost(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
}

function entryPriceFromSignal(signal: StrategySignal, override: number | undefined): number {
  const entryPrice = override ?? signal.features.close;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error("paper workflow entryPrice must be a finite positive number");
  }
  return entryPrice;
}

export function paperPositionToRiskPosition(position: PaperPosition): Position {
  const riskDecision = position.metadata.riskDecision;
  const maxRiskUsd = riskDecision && typeof riskDecision === "object"
    ? (riskDecision as { maxRiskUsd?: unknown }).maxRiskUsd
    : undefined;
  return {
    symbol: position.symbol,
    side: position.direction,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    markPrice: position.markPrice,
    openedAt: position.openedAt,
    unrealizedPnl: position.unrealizedPnl,
    ...(typeof maxRiskUsd === "number" && Number.isFinite(maxRiskUsd) ? { riskUsd: maxRiskUsd } : {}),
  };
}

async function loadOpenRiskPositions(input: CreatePaperTradeFromSignalInput): Promise<Position[]> {
  if (input.openRiskPositions) return input.openRiskPositions.map((position) => structuredClone(position));
  const openPaperPositions = await input.stores.paperStore.listPositions({ status: "open" });
  return openPaperPositions.map(paperPositionToRiskPosition);
}

function withPaperWorkflowMetadata(
  input: CreatePaperTradeFromSignalInput,
  riskDecision: RiskDecision,
): Record<string, unknown> {
  return {
    paperOnly: true,
    paperWorkflow: "P7E",
    regime: input.regime.regime,
    regimeReliability: input.regime.reliability,
    signalReasons: [...input.signal.reasons],
    riskVersion: riskDecision.riskVersion,
    ...(input.metadata ? structuredClone(input.metadata) : {}),
  };
}

export async function createPaperTradeFromSignal(
  input: CreatePaperTradeFromSignalInput,
): Promise<PaperTradeWorkflowResult> {
  assertNonNegativeCost("slippageBps", input.slippageBps);
  assertNonNegativeCost("feeBps", input.feeBps);
  const entryPrice = entryPriceFromSignal(input.signal, input.entryPrice);
  const nowTs = input.nowTs ?? input.signal.ts;
  if (!Number.isFinite(Date.parse(nowTs))) throw new Error("paper workflow nowTs must be a valid timestamp");

  const openPositions = await loadOpenRiskPositions(input);
  const riskDecision = evaluateRisk({
    signal: input.signal,
    regime: input.regime,
    accountEquity: input.accountEquity,
    openPositions,
    recentPnL: input.recentPnL ?? [],
    config: input.riskConfig,
    nowTs,
  });

  const tradeIntent = await input.stores.intentStore.insertIntent(createTradeIntent({
    signal: input.signal,
    riskDecision,
    entryPrice,
    entryLogic: input.entryLogic ?? "Paper workflow entry from deterministic strategy signal",
    sourceSignalIds: input.sourceSignalIds,
    metadata: withPaperWorkflowMetadata(input, riskDecision),
    nowTs,
    expiresAt: input.expiresAt ?? null,
  }));

  if (!riskDecision.approved) {
    return {
      ok: false,
      paperOnly: true,
      stage: "risk_rejected",
      riskDecision,
      tradeIntent,
      order: null,
      fill: null,
      position: null,
    };
  }

  const order = await input.stores.paperStore.insertOrder(createPaperOrder(tradeIntent, {
    slippageBps: input.slippageBps,
    feeBps: input.feeBps,
    orderType: input.orderType,
    nowTs,
    killSwitchEnabled: input.riskConfig.killSwitchEnabled,
  }));

  if (order.status !== "accepted") {
    return {
      ok: false,
      paperOnly: true,
      stage: "paper_order_rejected",
      riskDecision,
      tradeIntent,
      order,
      fill: null,
      position: null,
    };
  }

  const fill = await input.stores.paperStore.insertFill(simulatePaperFill(order, input.fillTs ?? nowTs));
  const filledOrder = await input.stores.paperStore.updateOrder({
    ...order,
    status: "filled",
    reason: "PAPER_ORDER_FILLED",
    filledAt: fill.ts,
    fillPrice: fill.fillPrice,
  });
  const position = await input.stores.paperStore.insertPosition(openPaperPosition(tradeIntent, filledOrder, fill));

  return {
    ok: true,
    paperOnly: true,
    stage: "position_opened",
    riskDecision,
    tradeIntent,
    order: filledOrder,
    fill,
    position,
  };
}

export async function monitorPaperPositions(
  input: MonitorPaperPositionsInput,
): Promise<MonitorPaperPositionsResult> {
  assertNonNegativeCost("slippageBps", input.slippageBps);
  assertNonNegativeCost("feeBps", input.feeBps);
  const openPositions = await input.stores.paperStore.listPositions({ status: "open" });
  const matching = openPositions.filter((position) => (
    position.symbol === input.bar.symbol &&
    position.exchange === input.bar.exchange
  ));
  const skippedPositions = openPositions.filter((position) => !matching.includes(position));
  const updatedPositions: PaperPosition[] = [];

  for (const position of matching) {
    const updated = updatePaperPositionWithBar(position, input.bar, {
      slippageBps: input.slippageBps,
      feeBps: input.feeBps,
      stopFirst: input.stopFirst,
    });
    updatedPositions.push(await input.stores.paperStore.updatePosition(updated));
  }

  return {
    paperOnly: true,
    evaluatedAt: input.bar.ts,
    updatedPositions,
    closedPositions: updatedPositions.filter((position) => position.status === "closed"),
    skippedPositions,
  };
}

export async function closePaperPositionManually(
  input: ClosePaperPositionManuallyInput,
): Promise<PaperPosition> {
  assertNonNegativeCost("slippageBps", input.slippageBps);
  assertNonNegativeCost("feeBps", input.feeBps);
  if (!Number.isFinite(input.manualClosePrice) || input.manualClosePrice <= 0) {
    throw new Error("manualClosePrice must be a finite positive number");
  }
  if (!Number.isFinite(Date.parse(input.manualCloseTs))) {
    throw new Error("manualCloseTs must be a valid timestamp");
  }

  const position = await input.stores.paperStore.fetchPosition(input.positionId);
  if (!position) throw new Error(`paper position not found: ${input.positionId}`);
  const bar: PaperPositionBar = {
    symbol: position.symbol,
    exchange: position.exchange as PaperPositionBar["exchange"],
    ts: input.manualCloseTs,
    open: input.manualClosePrice,
    high: input.manualClosePrice,
    low: input.manualClosePrice,
    close: input.manualClosePrice,
  };
  return input.stores.paperStore.updatePosition(updatePaperPositionWithBar(position, bar, {
    slippageBps: input.slippageBps,
    feeBps: input.feeBps,
    manualClosePrice: input.manualClosePrice,
    manualCloseTs: input.manualCloseTs,
  }));
}
