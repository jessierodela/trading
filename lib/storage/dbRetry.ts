/**
 * lib/storage/dbRetry.ts
 *
 * P11.1 — a small, deliberately narrow retry helper for transient Postgres
 * connectivity failures (pool checkout timeouts, dropped connections,
 * pooler saturation). It must never mask a real bug: only errors that look
 * like network/connection trouble are retried. Missing tables, bad SQL,
 * constraint violations, etc. fail on the first attempt, exactly as before.
 */

const TRANSIENT_ERROR_CODES = new Set([
  "ECHECKOUTTIMEOUT",
  "EDBHANDLEREXITED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  // Postgres SQLSTATE connection-exception class (08xxx) and admin
  // shutdown/crash class (57Pxx).
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "53300", // too_many_connections
]);

const TRANSIENT_MESSAGE_PATTERNS: RegExp[] = [
  /connection terminated unexpectedly/i,
  /connection to database closed/i,
  /too many clients/i,
  /timeout exceeded when trying to connect/i,
  /unable to check out connection from the pool/i,
  /terminating connection due to administrator command/i,
  /the database system is (starting up|shutting down|not yet accepting connections)/i,
];

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * True only for errors that look like transient DB connectivity trouble.
 * XX000 is deliberately excluded from the bare code list — poolers
 * (PgBouncer/Supavisor) overload it for all sorts of internal errors, so it
 * is only treated as transient when the message also mentions pooler /
 * connection wording, matching the spec's "XX000 with pooler/connection
 * text" rule rather than blanket-retrying an internal_error code.
 */
export function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = errorCode(err);
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
  const messageIsTransient = TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(err.message));
  if (messageIsTransient) return true;
  if (code === "XX000" && /pooler|connection/i.test(err.message)) return true;
  return false;
}

export interface DbRetryOptions {
  /** Total attempts including the first — must be >= 1. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry?: (info: { label: string; attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void;
  /** Injectable for tests — defaults to a real setTimeout-based sleep. */
  sleepFn?: (ms: number) => Promise<void>;
}

const DEFAULT_OPTIONS: DbRetryOptions = {
  maxAttempts: 1,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
};

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffWithJitter(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Retries fn() only on errors classified transient by isTransientDbError().
 * Any other error (schema/programmer/validation) is thrown immediately on
 * the first attempt — this never hides a real bug behind silent retries.
 */
export async function withDbRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options: Partial<DbRetryOptions> = {},
): Promise<T> {
  const opts: DbRetryOptions = { ...DEFAULT_OPTIONS, ...options };
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
    throw new Error("withDbRetry maxAttempts must be a positive integer");
  }
  const sleep = opts.sleepFn ?? realSleep;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDbError(err) || attempt >= opts.maxAttempts) throw err;
      const delayMs = backoffWithJitter(attempt, opts.baseDelayMs, opts.maxDelayMs);
      opts.onRetry?.({ label, attempt, maxAttempts: opts.maxAttempts, delayMs, error: err });
      console.warn(
        `[storage/dbRetry] ${label} transient DB error on attempt ${attempt}/${opts.maxAttempts}, retrying in ${delayMs}ms:`,
        err instanceof Error ? err.message : String(err),
      );
      await sleep(delayMs);
    }
  }
}
