"use client";

/**
 * components/layout/Sidebar.tsx
 * Polls /api/market every 30s for live prices.
 * Falls back to static WATCHLIST data while loading.
 */

import { useEffect, useState, useCallback } from "react";
import { AssetRow } from "@/components/ui/AssetRow";
import type { WatchlistAsset } from "@/types/market";
import { WATCHLIST } from "@/config/assets";

export function Sidebar() {
  const [watchlist, setWatchlist]   = useState<WatchlistAsset[]>(WATCHLIST);
  const [activeSymbol, setActive]   = useState<string>(WATCHLIST[0]?.symbol ?? "");

  const fetchPrices = useCallback(async () => {
    try {
      const res  = await fetch("/api/market");
      const data = await res.json();
      if (data.quotes && Array.isArray(data.quotes)) {
        setWatchlist(data.quotes);
      }
    } catch {
      // Keep showing static data on error
    }
  }, []);

  useEffect(() => {
    fetchPrices();
    const id = setInterval(fetchPrices, 30_000);
    return () => clearInterval(id);
  }, [fetchPrices]);

  return (
    <aside className="w-[160px] shrink-0 border-r border-[var(--color-border-default)] flex flex-col overflow-hidden">
      <div className="px-[14px] py-[10px] border-b border-[var(--color-border-default)] shrink-0">
        <span className="text-[9px] text-[var(--color-text-dim)] tracking-[.14em]">WATCHLIST</span>
      </div>
      <div className="overflow-y-auto flex-1">
        {watchlist.map((asset) => (
          <AssetRow
            key={asset.symbol}
            asset={asset}
            isActive={asset.symbol === activeSymbol}
            onClick={() => setActive(asset.symbol)}
          />
        ))}
      </div>
    </aside>
  );
}
