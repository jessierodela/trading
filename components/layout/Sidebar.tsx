"use client";

import { useState } from "react";
import { AssetRow } from "@/components/ui/AssetRow";
import type { WatchlistAsset } from "@/types/market";

interface SidebarProps {
  watchlist: WatchlistAsset[];
}

export function Sidebar({ watchlist }: SidebarProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  const stocks = watchlist.filter((a) => a.type === "stock");
  const crypto = watchlist.filter((a) => a.type === "crypto");

  return (
    <aside className="w-[220px] border-r border-[var(--color-border-default)] flex flex-col overflow-hidden bg-[var(--color-surface-panel)] shrink-0">

      <div className="px-[14px] py-[10px] text-[8px] text-[var(--color-text-dim)] tracking-[.18em] border-b border-[var(--color-border-default)]">
        WATCHLIST{" "}
        <span className="text-[var(--color-text-muted)]">({watchlist.length})</span>
      </div>

      <div className="overflow-y-auto flex-1">
        {/* Equities */}
        <div className="px-[14px] py-[8px] text-[8px] text-[var(--color-text-dim)] tracking-[.14em]">
          EQUITIES
        </div>
        {stocks.map((asset, i) => (
          <AssetRow
            key={asset.symbol}
            asset={asset}
            isActive={activeIndex === i}
            onClick={() => setActiveIndex(i)}
          />
        ))}

        {/* Crypto */}
        <div className="px-[14px] py-[8px] text-[8px] text-[var(--color-text-dim)] tracking-[.14em] border-t border-[var(--color-border-default)] mt-1">
          CRYPTO
        </div>
        {crypto.map((asset, i) => (
          <AssetRow
            key={asset.symbol}
            asset={asset}
            isActive={activeIndex === stocks.length + i}
            onClick={() => setActiveIndex(stocks.length + i)}
          />
        ))}
      </div>
    </aside>
  );
}
