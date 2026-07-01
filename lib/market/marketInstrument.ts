import type { MarketIdentity } from "@/lib/dataQuality/marketIdentity";
import type { MarketInstrument } from "./types";

export function marketInstrumentFromIdentity(identity: MarketIdentity): MarketInstrument {
  return {
    canonicalSymbol: identity.canonicalSymbol,
    displaySymbol: identity.displaySymbol,
    baseAsset: identity.baseAsset,
    quoteAsset: identity.quoteAsset,
    exchange: identity.exchange,
  };
}

export function canonicalScheduledMarketInstrument(): MarketInstrument {
  return {
    canonicalSymbol: "BTC-USD",
    displaySymbol: "BTC",
    baseAsset: "BTC",
    quoteAsset: "USD",
    exchange: "COINBASE",
  };
}
