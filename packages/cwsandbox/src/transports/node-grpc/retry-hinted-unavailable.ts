// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";

import { CWSANDBOX_ERROR_DOMAIN, CWSANDBOX_SANDBOX_NOT_FOUND } from "../../internal/error-info.js";
import { sleep as abortableSleep } from "../../internal/retry-transient-rpc.js";
import { parseStatusDetailsFromMetadata } from "./error-info.js";

/** Total calls, first try included. */
export const HINTED_RETRY_MAX_ATTEMPTS = 3;
/** Above this hint, rethrow the RPC error rather than clamp the delay. */
export const HINTED_RETRY_MAX_DELAY_MS = 10_000;
/** Upward-only jitter on the server's delay: never sleep less than asked. */
export const HINTED_RETRY_JITTER = 0.2;
/**
 * With a timeout, reserve this much after backoff to avoid masking
 * UNAVAILABLE with a deadline error from a starved retry.
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
 * Inspect raw status: CWSandboxUnavailableError also covers bare UNAVAILABLE
 * and unavailable reasons on other statuses, neither of which qualifies.
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
 * Retry an idempotent unary operation only on UNAVAILABLE with RetryInfo.
 * `attempt` must make one call and propagate unmapped `RpcError`s.
 * Wrap this helper in `withGrpcErrorMapping`; exhaustion preserves the last
 * error, while backoff cancellation produces a CANCELLED `RpcError`.
 *
 * Hints authorize retries here: zero adds no backoff; oversized hints stop
 * retries. `retryTransientRpc` instead clamps hints and uses its own backoff
 * for missing/zero hints. Review both when changing hint handling.
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
