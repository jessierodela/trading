import type { Bar, FeatureSnapshot, StrategySignal } from "@/lib/quant/types";
import type { DataQualityIssue, DataQualityReport, DataQualitySeverity } from "@/lib/dataQuality/types";
import { createDataQualityReport } from "@/lib/dataQuality/types";
import {
  assertCompatibleMarketIdentity,
  describeMarketIdentity,
  normalizeMarketIdentity,
  type MarketIdentity,
} from "@/lib/dataQuality/marketIdentity";
import type { MarketProvider, SourceLineage } from "./types";

function asProvider(source: string | undefined): MarketProvider {
  if (source === "coinbase" || source === "polygon" || source === "taapi" || source === "yahoo") return source;
  if (source === "internal") return "internal";
  return "unknown";
}

function lineageIsEmpty(lineage: SourceLineage | null | undefined): boolean {
  return !lineage || Object.keys(lineage).length === 0;
}

export function hasSourceLineage(lineage: SourceLineage | null | undefined): lineage is SourceLineage {
  return !lineageIsEmpty(lineage);
}

function uniq(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

export function sourceLineageFromIdentity(input: {
  identity: MarketIdentity;
  kind: SourceLineage["kind"];
  dataSourceVersion?: string;
  featureVersion?: string;
  modelVersion?: string;
  strategyVersion?: string;
  transform?: string;
  transformedAt?: string;
  inputSources?: SourceLineage[];
  notes?: string[];
}): SourceLineage {
  return {
    kind: input.kind,
    provider: input.identity.source,
    source: input.identity.source,
    canonicalSymbol: input.identity.canonicalSymbol,
    exchange: input.identity.exchange,
    baseAsset: input.identity.baseAsset,
    quoteAsset: input.identity.quoteAsset,
    vendorSymbol: input.identity.vendorSymbol,
    normalizedFrom: input.identity.normalizedFrom,
    dataSourceVersion: input.dataSourceVersion,
    featureVersion: input.featureVersion,
    modelVersion: input.modelVersion,
    strategyVersion: input.strategyVersion,
    transform: input.transform,
    transformedAt: input.transformedAt,
    inputSources: input.inputSources,
    notes: input.notes,
  };
}

export function sourceLineageFromBar(bar: Pick<Bar, "symbol" | "exchange"> & Partial<Bar>): SourceLineage {
  if (!lineageIsEmpty(bar.sourceLineage)) return bar.sourceLineage as SourceLineage;
  const identity = normalizeMarketIdentity({
    symbol: bar.symbol,
    exchange: bar.exchange,
    source: bar.source ?? "unknown",
    vendorSymbol: bar.vendorSymbol ?? bar.symbol,
    quoteAsset: bar.quoteAsset,
  });
  return sourceLineageFromIdentity({
    identity,
    kind: "market_bar",
    dataSourceVersion: bar.dataSourceVersion ?? undefined,
  });
}

export function sourceLineageFromFeature(feature: Pick<FeatureSnapshot, "symbol" | "exchange" | "featureVersion"> & Partial<FeatureSnapshot>): SourceLineage {
  if (!lineageIsEmpty(feature.sourceLineage)) return feature.sourceLineage as SourceLineage;
  const identity = normalizeMarketIdentity({
    symbol: feature.symbol,
    exchange: feature.exchange,
    source: feature.source ?? "unknown",
    vendorSymbol: feature.vendorSymbol ?? feature.symbol,
    quoteAsset: feature.quoteAsset,
  });
  return sourceLineageFromIdentity({
    identity,
    kind: "feature_snapshot",
    featureVersion: feature.featureVersion ?? undefined,
  });
}

export function sourceLineageFromSignal(signal: StrategySignal): SourceLineage {
  if (!lineageIsEmpty(signal.sourceLineage)) return signal.sourceLineage as SourceLineage;
  return buildDerivedSourceLineage({
    kind: "strategy_signal",
    source: "strategies.evaluate",
    transform: signal.strategyId,
    transformedAt: signal.ts,
    identity: normalizeMarketIdentity({
      symbol: signal.symbol,
      exchange: signal.exchange,
      source: "unknown",
    }),
    inputSources: [sourceLineageFromFeature(signal.features)],
    strategyVersion: signal.strategyVersion,
    featureVersion: signal.featureVersion,
  });
}

export function buildDerivedSourceLineage(input: {
  kind: SourceLineage["kind"];
  source: string;
  transform: string;
  transformedAt: string;
  identity: MarketIdentity;
  inputSources: SourceLineage[];
  featureVersion?: string | null;
  modelVersion?: string | null;
  strategyVersion?: string | null;
  notes?: string[];
}): SourceLineage {
  return {
    kind: input.kind,
    provider: "internal",
    source: input.source,
    canonicalSymbol: input.identity.canonicalSymbol,
    exchange: input.identity.exchange,
    baseAsset: input.identity.baseAsset,
    quoteAsset: input.identity.quoteAsset,
    vendorSymbol: input.identity.vendorSymbol,
    normalizedFrom: input.identity.normalizedFrom,
    transform: input.transform,
    transformedAt: input.transformedAt,
    inputSources: input.inputSources,
    featureVersion: input.featureVersion ?? undefined,
    modelVersion: input.modelVersion ?? undefined,
    strategyVersion: input.strategyVersion ?? undefined,
    notes: input.notes,
  };
}

export function attachBarLineage(input: {
  bar: Bar;
  expectedIdentity: MarketIdentity;
  source: string;
  dataSourceVersion: string;
}): Bar {
  const identity = normalizeMarketIdentity({
    symbol: input.bar.symbol,
    exchange: input.bar.exchange,
    source: input.source,
    vendorSymbol: input.bar.vendorSymbol ?? input.bar.symbol,
    quoteAsset: input.bar.quoteAsset,
  });
  return {
    ...input.bar,
    source: input.source,
    vendorSymbol: identity.vendorSymbol,
    quoteAsset: identity.quoteAsset,
    dataSourceVersion: input.dataSourceVersion,
    sourceLineage: sourceLineageFromIdentity({
      identity,
      kind: "market_bar",
      dataSourceVersion: input.dataSourceVersion,
      notes: identity.canonicalSymbol === input.expectedIdentity.canonicalSymbol ? undefined : [
        `expected ${describeMarketIdentity(input.expectedIdentity)}`,
      ],
    }),
  };
}

export function sourceLineageIssues(input: {
  scope: string;
  expectedIdentity: MarketIdentity;
  lineages: Array<SourceLineage | null | undefined>;
  symbol?: string;
  exchange?: string;
  timeframe?: string;
  missingSeverity?: DataQualitySeverity;
}): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  const present = input.lineages.filter((lineage): lineage is SourceLineage => !lineageIsEmpty(lineage));
  const missingCount = input.lineages.length - present.length;

  if (missingCount > 0) {
    issues.push({
      code: "SOURCE_LINEAGE_MISSING",
      severity: input.missingSeverity ?? "warn",
      message: `${missingCount} row(s) do not carry persisted source lineage; treating as legacy/audit-only context.`,
      symbol: input.symbol,
      exchange: input.exchange,
      timeframe: input.timeframe,
      expected: "source_lineage",
      actual: "missing",
    });
  }

  for (const lineage of present) {
    const actualIdentity = normalizeMarketIdentity({
      symbol: lineage.canonicalSymbol,
      exchange: lineage.exchange,
      source: asProvider(lineage.provider),
      vendorSymbol: lineage.vendorSymbol ?? lineage.canonicalSymbol,
      quoteAsset: lineage.quoteAsset,
    });
    const identityIssues = assertCompatibleMarketIdentity(input.expectedIdentity, actualIdentity);
    for (const issue of identityIssues) {
      issues.push({
        ...issue,
        code: issue.code === "MARKET_SYMBOL_NORMALIZED" ? "SOURCE_LINEAGE_SYMBOL_NORMALIZED" : `SOURCE_LINEAGE_${issue.code}`,
        message: `Source lineage ${issue.message}`,
        symbol: input.symbol ?? issue.symbol,
        exchange: input.exchange ?? issue.exchange,
        timeframe: input.timeframe,
      });
    }
  }

  const canonicalSymbols = uniq(present.map((lineage) => lineage.canonicalSymbol));
  const exchanges = uniq(present.map((lineage) => lineage.exchange));
  const quotes = uniq(present.map((lineage) => lineage.quoteAsset));
  const providers = uniq(present.map((lineage) => lineage.provider));

  if (canonicalSymbols.length > 1) {
    issues.push({
      code: "SOURCE_LINEAGE_MIXED_SYMBOLS",
      severity: "block",
      message: "Feature window mixes source lineage symbols.",
      symbol: input.symbol,
      exchange: input.exchange,
      timeframe: input.timeframe,
      expected: input.expectedIdentity.canonicalSymbol,
      actual: canonicalSymbols,
    });
  }
  if (exchanges.length > 1) {
    issues.push({
      code: "SOURCE_LINEAGE_MIXED_EXCHANGES",
      severity: "block",
      message: "Feature window mixes exchanges.",
      symbol: input.symbol,
      exchange: input.exchange,
      timeframe: input.timeframe,
      expected: input.expectedIdentity.exchange,
      actual: exchanges,
    });
  }
  if (quotes.length > 1) {
    issues.push({
      code: "SOURCE_LINEAGE_MIXED_QUOTES",
      severity: "block",
      message: "Feature window mixes quote assets and cannot be trusted without explicit normalization.",
      symbol: input.symbol,
      exchange: input.exchange,
      timeframe: input.timeframe,
      expected: input.expectedIdentity.quoteAsset,
      actual: quotes,
    });
  }
  if (providers.length > 1) {
    issues.push({
      code: "SOURCE_LINEAGE_MIXED_PROVIDERS",
      severity: "warn",
      message: "Feature window mixes data providers; verify this is display-only or explicitly normalized.",
      symbol: input.symbol,
      exchange: input.exchange,
      timeframe: input.timeframe,
      expected: input.expectedIdentity.source,
      actual: providers,
    });
  }

  return issues;
}

export function sourceLineageQualityReport(input: {
  scope: string;
  checkedAt: string;
  expectedIdentity: MarketIdentity;
  lineages: Array<SourceLineage | null | undefined>;
  symbol?: string;
  exchange?: string;
  timeframe?: string;
  missingSeverity?: DataQualitySeverity;
}): DataQualityReport {
  return createDataQualityReport({
    scope: input.scope,
    checkedAt: input.checkedAt,
    symbol: input.symbol,
    exchange: input.exchange,
    timeframe: input.timeframe,
    issues: sourceLineageIssues(input),
  });
}
