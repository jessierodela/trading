import type { NormalizationPolicy } from "./types";

export const NO_IMPLICIT_QUOTE_NORMALIZATION_POLICY = "no_implicit_quote_normalization";

export function quoteMismatchPolicyDescription(): string {
  return "Quote-asset mismatches such as BTC/USDT to BTC-USD require a future explicit normalization policy and must not be silently coerced.";
}

export function isExplicitNormalizationAllowed(
  policies: NormalizationPolicy[] | undefined,
  policyId: string,
): boolean {
  return (policies ?? []).some((policy) =>
    policy.id === policyId &&
    policy.explicit === true &&
    policy.status === "allowed"
  );
}
