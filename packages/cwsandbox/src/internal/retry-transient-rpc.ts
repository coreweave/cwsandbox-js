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

export interface RetryTransientRpcOptions {
  readonly budgetMs: number;
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
 * attempt. On exhaustion the last error is re-raised unchanged.
 */
export async function retryTransientRpc<T>(
  attempt: () => Promise<T>,
  options: RetryTransientRpcOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleepFn = options.sleep ?? sleep;
  const nonRetryable = options.nonRetryable ?? [];

  let retryDeadline: number | undefined;
  let lastError: unknown;
  let prevSleepMs = DEFAULT_POLL_INTERVAL_MS;

  while (true) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (
        !isCWSandboxError(error) ||
        nonRetryable.some((type) => error instanceof type) ||
        classifyPollError(error) !== "retryable" ||
        options.budgetMs <= 0
      ) {
        throw error;
      }

      if (retryDeadline === undefined) {
        retryDeadline = now() + options.budgetMs;
      }

      const current = now();
      if (current >= retryDeadline) {
        throw error;
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
        throw lastError;
      }
    }
  }
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
