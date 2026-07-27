// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  type CWSandboxError,
  CWSandboxNotFoundError,
  CWSandboxResourceExhaustedError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
  isCWSandboxError,
} from "../errors.js";

/** Python `DEFAULT_POLL_INTERVAL_SECONDS` (0.2s). */
export const DEFAULT_POLL_INTERVAL_MS = 200;
/** Python `DEFAULT_MAX_POLL_INTERVAL_SECONDS` (2.0s). */
export const DEFAULT_MAX_POLL_INTERVAL_MS = 2_000;
/** Python `DEFAULT_POLL_BACKOFF_FACTOR`. */
export const DEFAULT_POLL_BACKOFF_FACTOR = 1.5;
/** Python `DEFAULT_POLL_RETRY_BUDGET_SECONDS` (30s). */
export const DEFAULT_POLL_RETRY_BUDGET_MS = 30_000;
/** Python `DEFAULT_POLL_RPC_TIMEOUT_SECONDS` (15s). */
export const DEFAULT_POLL_RPC_TIMEOUT_MS = 15_000;
/** Python `MAX_POLL_RETRY_HINTED_DELAY_SECONDS` (10s). */
export const MAX_POLL_RETRY_HINTED_DELAY_MS = 10_000;
/**
 * Minimum per-attempt RPC timeout after a retryable failure. Below this we skip
 * the Get and rethrow the last error (stricter than Python's 0.1s floor, which
 * can slightly overrun the deadline).
 */
export const MIN_POLL_RPC_TIMEOUT_MS = 100;

export type PollErrorClassification = "retryable" | "fatal";

export function classifyPollError(error: unknown): PollErrorClassification {
  if (error instanceof CWSandboxNotFoundError) {
    return "fatal";
  }
  if (
    error instanceof CWSandboxUnavailableError ||
    error instanceof CWSandboxTimeoutError ||
    error instanceof CWSandboxResourceExhaustedError
  ) {
    return "retryable";
  }
  return "fatal";
}

export interface RetryAttemptContext {
  readonly timeoutMs: number;
}

export interface RetryTransientRpcOptions {
  readonly budgetMs: number;
  /**
   * Absolute wall-clock deadline (same epoch as `now`). When set, retry sleeps
   * and per-attempt RPC timeouts are clamped so the helper cannot run past it.
   */
  readonly deadline?: number;
  readonly nonRetryable?: readonly (new (...args: never[]) => CWSandboxError)[];
  readonly now?: () => number;
  readonly operation: string;
  readonly random?: () => number;
  readonly signal?: AbortSignal;
  readonly sleep?: (timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>;
}

/**
 * Run `attempt` with bounded retry on transient CWSandbox errors (Python
 * `_retry_transient_rpc` / `_poll_with_retry` parity).
 *
 * `budgetMs` caps wall-clock time spent *retrying*; it never delays the first
 * attempt. Optional `deadline` clamps the retry burst and each attempt's
 * `timeoutMs`. On exhaustion the last error is re-raised unchanged.
 */
export async function retryTransientRpc<T>(
  attempt: (ctx: RetryAttemptContext) => Promise<T>,
  options: RetryTransientRpcOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleepFn = options.sleep ?? sleep;
  const nonRetryable = options.nonRetryable ?? [];

  let retryDeadline: number | undefined;
  let lastError: CWSandboxError | undefined;
  let prevSleepMs = DEFAULT_POLL_INTERVAL_MS;

  while (true) {
    const timeoutMs = resolveAttemptTimeoutMs({
      budgetMs: options.budgetMs,
      deadline: options.deadline,
      now: now(),
      retryDeadline,
    });
    if (timeoutMs === undefined) {
      if (lastError !== undefined) {
        rethrowError(lastError);
      }
      // First attempt with no usable remaining time: still invoke once with a
      // 1ms timeout so callers/transports observe a real attempt rather than a
      // synthetic error invented by the helper.
      return await attempt({ timeoutMs: 1 });
    }

    try {
      return await attempt({ timeoutMs });
    } catch (error) {
      if (
        !isCWSandboxError(error) ||
        nonRetryable.some((type) => error instanceof type) ||
        classifyPollError(error) !== "retryable" ||
        options.budgetMs <= 0
      ) {
        rethrowError(error);
      }

      lastError = error;

      if (retryDeadline === undefined) {
        const armed = now() + options.budgetMs;
        retryDeadline =
          options.deadline === undefined ? armed : Math.min(armed, options.deadline);
      }

      const current = now();
      if (current >= retryDeadline) {
        rethrowError(lastError);
      }

      const remainingMs = retryDeadline - current;
      const hintedDelayMs =
        error instanceof CWSandboxTransportError ? error.retryDelayMs : undefined;
      let sleepForMs: number;
      if (hintedDelayMs !== undefined && hintedDelayMs > 0) {
        sleepForMs = Math.min(hintedDelayMs, remainingMs, MAX_POLL_RETRY_HINTED_DELAY_MS);
      } else {
        const base = DEFAULT_POLL_INTERVAL_MS;
        const cap = DEFAULT_MAX_POLL_INTERVAL_MS;
        const jitterCeiling = Math.max(
          base,
          Math.min(cap, prevSleepMs * DEFAULT_POLL_BACKOFF_FACTOR, remainingMs),
        );
        sleepForMs = Math.min(base + random() * (jitterCeiling - base), remainingMs);
      }

      await sleepFn(sleepForMs, options.signal);
      prevSleepMs = sleepForMs;

      if (now() >= retryDeadline) {
        rethrowError(lastError);
      }
    }
  }
}

/** Satisfy `typescript/only-throw-error` while rethrowing caught values unchanged. */
function rethrowError(error: unknown): never {
  if (error instanceof Error) {
    throw error;
  }
  throw new Error(typeof error === "string" ? error : "Unknown error", { cause: error });
}

/**
 * Compute the next attempt's RPC timeout, or `undefined` when a retry Get
 * should be skipped (remaining &lt; {@link MIN_POLL_RPC_TIMEOUT_MS}).
 */
export function resolveAttemptTimeoutMs(args: {
  readonly budgetMs: number;
  readonly deadline: number | undefined;
  readonly now: number;
  readonly retryDeadline: number | undefined;
}): number | undefined {
  const { budgetMs, deadline, now: current, retryDeadline } = args;

  let remainingMs: number;
  if (retryDeadline !== undefined) {
    remainingMs = retryDeadline - current;
  } else {
    // Python initial rpc_timeout_override: min(poll_rpc_timeout, budget).
    remainingMs = Math.min(DEFAULT_POLL_RPC_TIMEOUT_MS, budgetMs);
    if (deadline !== undefined) {
      remainingMs = Math.min(remainingMs, deadline - current);
    }
  }

  if (retryDeadline !== undefined && remainingMs < MIN_POLL_RPC_TIMEOUT_MS) {
    return undefined;
  }

  if (remainingMs <= 0) {
    return undefined;
  }

  return Math.min(DEFAULT_POLL_RPC_TIMEOUT_MS, remainingMs);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export function sleep(timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      try {
        signal?.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
