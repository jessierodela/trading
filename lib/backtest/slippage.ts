export function applyEntrySlippage(
  price: number,
  side: "long" | "short",
  slippageBps: number,
): number {
  const factor = slippageBps / 10_000;
  return side === "long" ? price * (1 + factor) : price * (1 - factor);
}

export function applyExitSlippage(
  price: number,
  side: "long" | "short",
  slippageBps: number,
): number {
  const factor = slippageBps / 10_000;
  return side === "long" ? price * (1 - factor) : price * (1 + factor);
}

export function feeForNotional(notional: number, feeBps: number): number {
  return Math.abs(notional) * feeBps / 10_000;
}

