// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";

import { CWSANDBOX_ERROR_DOMAIN, CWSANDBOX_SANDBOX_NOT_FOUND } from "../../internal/error-info.js";
import { sleep as abortableSleep } from "../../internal/retry-transient-rpc.js";
import { parseStatusDetailsFromMetadata } from "./error-info.js";

/** Total calls, first try included. */
export const HINTED_RETRY_MAX_ATTEMPTS = 3;
/** A server hint above this is raised rather than slept or clamped. */
export const HINTED_RETRY_MAX_DELAY_MS = 10_000;
/** Upward-only jitter on the server's delay: never sleep less than asked. */
export const HINTED_RETRY_JITTER = 0.2;
/**
 * With a finite timeout, a retry needs at least this much of it left after the
 * backoff, so a starved last call cannot fail with DEADLINE_EXCEEDED and hide
 * the server's UNAVAILABLE reason.
 */
export const HINTED_RETRY_MIN_ATTEMPT_MS = 5_000;

export interface HintedRetryOptions {
  readonly operation: string;
  /** Bounds the whole sequence; the first call gets it unchanged. No new deadline when omitted. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxAttempts?: number;
  /** Test seams. */
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>;
  readonly log?: (message: string) => void;
}

interface Hint {
  readonly delayMs: number;
  readonly reason: string | undefined;
}

/**
 * The server's retry hint when `error` is a raw gRPC `UNAVAILABLE` carrying a
 * usable, non-negative AIP-193 `RetryInfo` delay; otherwise undefined.
 *
 * Checked on the raw status, not the mapped error class: the SDK also maps
 * bare `UNAVAILABLE` (proxy, dead connection) and non-UNAVAILABLE statuses
 * with an unavailable reason to `CWSandboxUnavailableError`, and neither is
 * retried here.
 */
function hintOf(error: unknown): Hint | undefined {
  if (!(error instanceof RpcError) || error.code !== "UNAVAILABLE") {
    return undefined;
  }
  const parsed = parseStatusDetailsFromMetadata(error.meta);
  const delayMs = parsed?.retryDelayMs;
  if (delayMs === undefined || !(delayMs >= 0)) {
    return undefined;
  }
  return { delayMs, reason: parsed?.reason };
}

/** Raw gRPC NOT_FOUND, or a trusted `CWSANDBOX_SANDBOX_NOT_FOUND` reason. */
export function isRawSandboxNotFound(error: unknown): boolean {
  if (!(error instanceof RpcError)) {
    return false;
  }
  if (error.code === "NOT_FOUND") {
    return true;
  }
  const parsed = parseStatusDetailsFromMetadata(error.meta);
  return parsed?.domain === CWSANDBOX_ERROR_DOMAIN && parsed.reason === CWSANDBOX_SANDBOX_NOT_FOUND;
}

/**
 * Run one idempotent unary call, retrying only when the server says it is
 * transiently unavailable and says how long to wait.
 *
 * `attempt(timeoutMs)` makes exactly one raw call and lets the raw `RpcError`
 * escape; call it inside `withGrpcErrorMapping` so the final error is mapped
 * as before. A failure is retried only when fewer than `maxAttempts` calls
 * have been made, the error carries a hint (see `hintOf`) of at most
 * `HINTED_RETRY_MAX_DELAY_MS`, and, when `timeoutMs` is set, at least
 * `HINTED_RETRY_MIN_ATTEMPT_MS` of it remains after the backoff. Otherwise the
 * last raw error is rethrown. Aborting during the backoff throws a
 * `CANCELLED` `RpcError`, the same shape as cancelling an in-flight call.
 *
 * This reads `RetryInfo` differently from `retryTransientRpc` on purpose;
 * keep both in mind when changing either. That helper retries every
 * transient error with or without a hint, so it clamps a long hint and treats
 * a zero hint as missing and uses its own backoff. This one retries only
 * because the server supplied the hint, so it never sleeps less than the
 * hint: a zero hint retries at once, and a hint above the cap is raised
 * rather than clamped.
 */
export async function retryHintedUnavailable<T>(
  attempt: (timeoutMs: number | undefined) => Promise<T>,
  options: HintedRetryOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  const log = options.log ?? ((message: string) => console.info(message));
  const maxAttempts = options.maxAttempts ?? HINTED_RETRY_MAX_ATTEMPTS;
  const deadline = options.timeoutMs === undefined ? undefined : now() + options.timeoutMs;
  let timeoutMs = options.timeoutMs;

  for (let attempts = 1; ; attempts += 1) {
    try {
      return await attempt(timeoutMs);
    } catch (error) {
      const hint = attempts < maxAttempts ? hintOf(error) : undefined;
      if (hint === undefined || hint.delayMs > HINTED_RETRY_MAX_DELAY_MS) {
        throw error;
      }
      const sleepMs = hint.delayMs * (1 + HINTED_RETRY_JITTER * random());
      if (deadline !== undefined && now() + sleepMs + HINTED_RETRY_MIN_ATTEMPT_MS > deadline) {
        throw error;
      }
      log(
        `Retrying ${options.operation} after transient unavailability: ` +
          `reason=${hint.reason ?? "none"} attempt=${attempts + 1}/${maxAttempts} ` +
          `delay=${Math.round(sleepMs)}ms`,
      );
      try {
        await sleep(sleepMs, options.signal);
      } catch (abortReason) {
        throw cancelledDuringBackoff(options.operation, abortReason);
      }
      if (options.signal?.aborted === true) {
        throw cancelledDuringBackoff(options.operation, options.signal.reason);
      }
      if (deadline !== undefined) {
        timeoutMs = deadline - now();
        if (timeoutMs < HINTED_RETRY_MIN_ATTEMPT_MS) {
          throw error;
        }
      }
    }
  }
}

function cancelledDuringBackoff(operation: string, reason: unknown): RpcError {
  const error = new RpcError(`${operation} was cancelled during retry backoff`, "CANCELLED");
  error.cause = reason;
  return error;
}
