export type OpenAISkipReason =
  | "openai_disabled"
  | "openai_regime_disabled"
  | "openai_strategy_agents_disabled"
  | "openai_api_key_missing";

export type OptionalOpenAIErrorCode =
  | "openai_api_key_missing"
  | "openai_auth_failed"
  | "openai_quota_or_rate_limit"
  | "openai_provider_unavailable"
  | "openai_network_error";

export class OptionalOpenAIError extends Error {
  readonly optionalOpenAI = true;
  readonly code: OptionalOpenAIErrorCode;
  readonly status?: number;
  readonly body?: string;
  override readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code: OptionalOpenAIErrorCode;
      status?: number;
      body?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "OptionalOpenAIError";
    this.code = options.code;
    this.status = options.status;
    this.body = options.body;
    this.cause = options.cause;
  }
}

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

export function isOptionalOpenAIError(err: unknown): err is OptionalOpenAIError {
  return err instanceof OptionalOpenAIError || (
    typeof err === "object" &&
    err !== null &&
    (err as { optionalOpenAI?: unknown }).optionalOpenAI === true
  );
}

export function optionalOpenAIStatusCode(status: number): OptionalOpenAIErrorCode | null {
  if (status === 401 || status === 403) return "openai_auth_failed";
  if (status === 429) return "openai_quota_or_rate_limit";
  if (status === 408 || status === 409 || status >= 500) return "openai_provider_unavailable";
  return null;
}

export function optionalOpenAIHttpError(
  agent: string,
  status: number,
  body: string,
): OptionalOpenAIError | null {
  const code = optionalOpenAIStatusCode(status);
  if (!code) return null;
  return new OptionalOpenAIError(
    `[${agent}] optional OpenAI unavailable: status=${status}`,
    { code, status, body },
  );
}
