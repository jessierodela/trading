/**
 * lib/jobs/handlers/strategiesRiskGate.ts
 *
 * P11: the deterministic post-strategy approval layer for the scheduled
 * strategies.evaluate job. A persisted strategy signal only reaches here if
 * it is an actionable "trigger" — setup/exit/invalidated signals are
 * informational and never risk-evaluated or turned into trade intents.
 *
 * Flow: build risk input -> evaluate risk -> persist decision (approved AND
 * rejected) -> create a trade intent only when approved. Idempotent by
 * (signalId, riskVersion): a rerun for the same closed bar returns the
 * already-persisted decision and only ensures (never duplicates) the trade
 * intent.
 */
import { createTradeIntent, type TradeIntentStore } from "@/lib/tradeIntent";
import { buildScheduledRiskInput } from "@/lib/risk/adapters/scheduledRiskInput";
import { evaluateRisk } from "@/lib/risk/riskEngine";
import type { RiskDecisionStore } from "@/lib/risk/riskDecisionStore";
import type { RiskConfig, RiskDecision } from "@/lib/risk/types";
import { getScheduledAccountEquity, getScheduledRiskConfig } from "@/config/risk";
import { RISK_VERSION } from "@/lib/versions";
import type { PaperTradingStore } from "@/lib/execution";
import type { RegimeContext, StrategySignal } from "@/lib/quant/types";

export interface StrategiesRiskGateServices {
  paperStore: PaperTradingStore;
  intentStore: TradeIntentStore;
  riskDecisionStore: RiskDecisionStore;
}

export interface StrategiesRiskGateOptions {
  now: () => Date;
  accountEquity?: number;
  riskConfig?: RiskConfig;
  env?: NodeJS.ProcessEnv;
}

export interface ScheduledRiskGateResult {
  /** False for non-trigger signals — no risk evaluation was attempted. */
  evaluated: boolean;
  /** False when this rerun found (and reused) an already-persisted decision. */
  isNewDecision: boolean;
  approved: boolean | null;
  intentCreated: boolean;
  decision: RiskDecision | null;
}

const SKIPPED_RESULT: ScheduledRiskGateResult = {
  evaluated: false,
  isNewDecision: false,
  approved: null,
  intentCreated: false,
  decision: null,
};

/** Only "trigger" signals are actionable; setup/exit/invalidated are informational. */
export function isActionableTriggerSignal(signal: Pick<StrategySignal, "signalType">): boolean {
  return signal.signalType === "trigger";
}

function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof Error && /duplicate|unique/i.test(err.message);
}

export async function runScheduledRiskGate(
  signal: StrategySignal & { id: number },
  regime: RegimeContext | null,
  services: StrategiesRiskGateServices,
  options: StrategiesRiskGateOptions,
): Promise<ScheduledRiskGateResult> {
  if (!isActionableTriggerSignal(signal)) return SKIPPED_RESULT;

  const env = options.env ?? process.env;
  const nowTs = options.now().toISOString();
  const riskConfig = options.riskConfig ?? getScheduledRiskConfig(env);
  const accountEquity = options.accountEquity ?? getScheduledAccountEquity(env);

  const existing = await services.riskDecisionStore.findBySignalAndVersion(signal.id, RISK_VERSION);
  let decision: RiskDecision;
  let isNewDecision: boolean;

  if (existing) {
    decision = existing.decision;
    isNewDecision = false;
  } else {
    const riskInput = await buildScheduledRiskInput({
      signal,
      regime,
      accountEquity,
      config: riskConfig,
      nowTs,
      paperStore: services.paperStore,
    });
    decision = evaluateRisk(riskInput);
    await services.riskDecisionStore.insertDecision({
      signalId: signal.id,
      symbol: signal.symbol,
      exchange: signal.exchange,
      timeframe: signal.timeframe,
      signalTs: signal.ts,
      strategyId: signal.strategyId,
      decision,
      tradeIntentId: null,
      evaluatedAt: nowTs,
    });
    isNewDecision = true;
  }

  let intentCreated = false;
  if (decision.approved) {
    const tradeIntent = createTradeIntent({
      signal,
      riskDecision: decision,
      entryPrice: signal.features.close,
      entryLogic: "Scheduled risk-gated entry from strategies.evaluate",
      sourceSignalIds: [String(signal.id)],
      metadata: {
        paperOnly: true,
        source: "strategies.evaluate",
        regime: regime?.regime ?? "UNKNOWN",
      },
      nowTs,
    });
    try {
      const inserted = await services.intentStore.insertIntent(tradeIntent);
      intentCreated = true;
      // Back-link for audit traceability. Only reachable on the run whose
      // insertIntent() call actually succeeds (not the duplicate-key catch
      // below), so this never overwrites an existing link, and
      // linkTradeIntent() itself only ever sets a null trade_intent_id —
      // belt and suspenders against concurrent reruns.
      //
      // Known limitation: if a prior run's insertIntent() succeeded but the
      // process crashed before this link ran, a rerun will hit the
      // duplicate-key catch below (intentCreated stays false) and this link
      // step is skipped again — the decision row's trade_intent_id stays
      // null even though the intent exists. Both rows remain independently
      // correct and auditable by signalId; resolving the gap would require
      // a lookup-by-signal query path on TradeIntentStore that doesn't exist
      // today, which is more surface area than this edge case warrants.
      if (inserted.id) await services.riskDecisionStore.linkTradeIntent(signal.id, decision.riskVersion, inserted.id);
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // Already created by a prior run of this same (signal, risk version) pair.
      intentCreated = false;
    }
  }

  return { evaluated: true, isNewDecision, approved: decision.approved, intentCreated, decision };
}
