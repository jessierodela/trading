import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { PaperTradingPanelView } from "@/components/dashboard/PaperTradingPanelView";
import {
  createPaperTradingDashboardData,
  PAPER_TRADING_ONLY_LABEL,
} from "@/lib/dashboard/paperTrading";
import type { PaperPosition } from "@/lib/execution";
import type { RiskDecision } from "@/lib/risk/types";
import { RISK_VERSION } from "@/lib/versions";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}`, detail ?? "");
  }
}

const riskDecision: RiskDecision = {
  approved: true,
  reason: "Risk approved for dashboard smoke",
  sizeMultiplier: 0.5,
  maxRiskUsd: 100,
  positionSize: 2,
  stopLoss: 98,
  takeProfit: 104,
  blockedBy: [],
  warnings: ["PAPER_ONLY"],
  riskVersion: RISK_VERSION,
};

function position(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: "paper-position-open",
    tradeIntentId: "paper-intent-1",
    orderId: "paper-order-1",
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    direction: "LONG",
    quantity: 2,
    entryPrice: 100,
    markPrice: 103,
    stopLoss: 98,
    takeProfit: 104,
    openedAt: "2026-06-16T12:03:00.000Z",
    closedAt: null,
    exitPrice: null,
    realizedPnl: null,
    unrealizedPnl: 5.79,
    fees: 0.21,
    status: "open",
    metadata: {
      paperOnly: true,
      riskVersion: RISK_VERSION,
      riskDecision,
      sourceSignalIds: ["signal-1", "signal-2"],
      strategyId: "momentum_continuation",
      strategyVersion: "strategy.dashboard.v1",
      featureVersion: "features.dashboard.v1",
      tradeIntentMetadata: {
        regime: "TREND_UP",
      },
    },
    ...overrides,
  };
}

function assertNoLiveControls(html: string): void {
  const forbidden = [
    "<button",
    "Submit Order",
    "Close Live Position",
    "Broker Connect",
    "Live Trading Toggle",
    "API Key Input",
    ">Buy<",
    ">Sell<",
  ];
  assert("no live execution controls rendered", forbidden.every((text) => !html.includes(text)), forbidden.filter((text) => html.includes(text)));
}

function main(): void {
  const emptyHtml = renderToStaticMarkup(
    <PaperTradingPanelView
      data={createPaperTradingDashboardData(
        [],
        [],
        "unconfigured",
        "Set SUPABASE_DB_URL or DATABASE_URL to load persisted paper trading state.",
        null,
      )}
    />,
  );
  assert("paper panel handles empty state", emptyHtml.includes("No open paper positions") && emptyHtml.includes("No closed paper trades"), emptyHtml);
  assert("paper panel labels paper-only state on empty state", emptyHtml.includes(PAPER_TRADING_ONLY_LABEL), emptyHtml);
  assertNoLiveControls(emptyHtml);

  const openPosition = position();
  const closedPosition = position({
    id: "paper-position-closed",
    orderId: "paper-order-2",
    status: "closed",
    markPrice: 103.8,
    closedAt: "2026-06-16T13:05:00.000Z",
    exitPrice: 103.8,
    realizedPnl: 7.12,
    unrealizedPnl: 0,
    fees: 0.31,
    metadata: {
      ...position().metadata,
      closeReason: "manual",
    },
  });
  const fixtureHtml = renderToStaticMarkup(
    <PaperTradingPanelView
      data={createPaperTradingDashboardData(
        [openPosition],
        [closedPosition],
        "ready",
        "Loaded from paper trading persistence.",
        "2026-06-16T14:00:00.000Z",
      )}
    />,
  );

  assert("paper panel displays open position row", fixtureHtml.includes("Open Paper Positions") && fixtureHtml.includes("BTC-USD") && fixtureHtml.includes("Unrealized"), fixtureHtml);
  assert("paper panel displays closed trade row", fixtureHtml.includes("Closed Paper Trades") && fixtureHtml.includes("manual") && fixtureHtml.includes("Realized"), fixtureHtml);
  assert("paper panel displays PnL summary", fixtureHtml.includes("PnL Summary") && fixtureHtml.includes("Win Rate") && fixtureHtml.includes("Open Exposure"), fixtureHtml);
  assert("paper panel exposes risk lineage", fixtureHtml.includes("Risk And Strategy Lineage") && fixtureHtml.includes("signal-1, signal-2") && fixtureHtml.includes(RISK_VERSION), fixtureHtml);
  assert("paper panel exposes strategy and feature lineage", fixtureHtml.includes("strategy.dashboard.v1") && fixtureHtml.includes("features.dashboard.v1"), fixtureHtml);
  assert("paper panel exposes regime metadata", fixtureHtml.includes("TREND_UP"), fixtureHtml);
  assert("paper panel labels paper-only state", fixtureHtml.includes(PAPER_TRADING_ONLY_LABEL), fixtureHtml);
  assertNoLiveControls(fixtureHtml);

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`} (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
