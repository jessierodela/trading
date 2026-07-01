import type { Exchange } from "@/lib/quant/types";
import type { MarketDataSource } from "@/lib/dataQuality/marketIdentity";

export type MarketProvider = MarketDataSource | "internal";

export interface MarketInstrument {
  canonicalSymbol: string;
  displaySymbol: string;
  baseAsset: string;
  quoteAsset: string;
  exchange: Exchange;
}

export interface ProviderSymbolIdentity {
  provider: MarketProvider;
  source: string;
  vendorSymbol: string;
  canonicalSymbol: string;
  exchange: Exchange;
  baseAsset: string;
  quoteAsset: string;
  normalizedFrom?: string;
}

export interface NormalizationPolicy {
  id: string;
  description: string;
  from: Pick<ProviderSymbolIdentity, "provider" | "vendorSymbol" | "quoteAsset" | "exchange">;
  to: Pick<ProviderSymbolIdentity, "provider" | "canonicalSymbol" | "quoteAsset" | "exchange">;
  explicit: true;
  status: "allowed" | "blocked" | "audit_only";
}

export interface SourceLineage {
  kind: "market_bar" | "feature_snapshot" | "regime_snapshot" | "strategy_signal" | "dashboard_display" | "audit";
  provider: MarketProvider;
  source: string;
  canonicalSymbol: string;
  exchange: Exchange;
  baseAsset: string;
  quoteAsset: string;
  vendorSymbol?: string;
  normalizedFrom?: string;
  dataSourceVersion?: string;
  featureVersion?: string;
  modelVersion?: string;
  strategyVersion?: string;
  transform?: string;
  transformedAt?: string;
  inputSources?: SourceLineage[];
  notes?: string[];
}
