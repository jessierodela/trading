export type AssetType = "stock" | "crypto";

export interface WatchlistAsset {
  symbol:   string;
  name:     string;
  price:    string;
  change:   string;
  changeUp: boolean;
  type:     AssetType;
}
