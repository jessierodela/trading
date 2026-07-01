import type { MarketIdentity } from "@/lib/dataQuality/marketIdentity";
import type { ProviderSymbolIdentity } from "./types";

export function providerSymbolFromIdentity(identity: MarketIdentity): ProviderSymbolIdentity {
  return {
    provider: identity.source,
    source: identity.source,
    vendorSymbol: identity.vendorSymbol ?? identity.canonicalSymbol,
    canonicalSymbol: identity.canonicalSymbol,
    exchange: identity.exchange,
    baseAsset: identity.baseAsset,
    quoteAsset: identity.quoteAsset,
    normalizedFrom: identity.normalizedFrom,
  };
}

export function describeProviderSymbol(identity: ProviderSymbolIdentity): string {
  const normalized = identity.normalizedFrom ? ` normalizedFrom=${identity.normalizedFrom}` : "";
  return `${identity.vendorSymbol} -> ${identity.canonicalSymbol} ${identity.exchange}/${identity.provider} quote=${identity.quoteAsset}${normalized}`;
}
