import type { WatchlistAsset } from "@/types/market";

export const WATCHLIST: WatchlistAsset[] = [
  { symbol: "AAPL", name: "Apple Inc.",    price: "$175.43",  change: "+1.24%", changeUp: true,  type: "stock"  },
  { symbol: "NVDA", name: "NVIDIA Corp.",  price: "$820.11",  change: "+3.67%", changeUp: true,  type: "stock"  },
  { symbol: "TSLA", name: "Tesla Inc.",    price: "$248.90",  change: "-2.10%", changeUp: false, type: "stock"  },
  { symbol: "MSFT", name: "Microsoft",     price: "$415.22",  change: "+0.88%", changeUp: true,  type: "stock"  },
  { symbol: "AMZN", name: "Amazon",        price: "$186.55",  change: "-0.31%", changeUp: false, type: "stock"  },
  { symbol: "SPY",  name: "S&P 500 ETF",   price: "$512.08",  change: "+0.43%", changeUp: true,  type: "stock"  },
  { symbol: "BTC",  name: "Bitcoin",       price: "$67,420",  change: "+2.33%", changeUp: true,  type: "crypto" },
  { symbol: "ETH",  name: "Ethereum",      price: "$3,512",   change: "+1.44%", changeUp: true,  type: "crypto" },
  { symbol: "SOL",  name: "Solana",        price: "$148.30",  change: "-3.21%", changeUp: false, type: "crypto" },
  { symbol: "BNB",  name: "BNB Chain",     price: "$582.10",  change: "+0.72%", changeUp: true,  type: "crypto" },
];
