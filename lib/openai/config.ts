export type OpenAISkipReason =
  | "openai_disabled"
  | "openai_regime_disabled"
  | "openai_strategy_agents_disabled"
  | "openai_api_key_missing";

function enabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

export function isOpenAIEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled(env.OPENAI_ENABLED);
}

export function isOpenAIRegimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOpenAIEnabled(env) && enabled(env.OPENAI_REGIME_ENABLED);
}

export function isOpenAIStrategyAgentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOpenAIEnabled(env) && enabled(env.OPENAI_STRATEGY_AGENTS_ENABLED);
}

export function openAIDisabledResult(reason: OpenAISkipReason): {
  aiCommentarySkipped: true;
  reason: OpenAISkipReason;
} {
  return { aiCommentarySkipped: true, reason };
}
