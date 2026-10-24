// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";

import { CWSANDBOX_ERROR_DOMAIN } from "../../internal/error-info.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_MAX_POLL_INTERVAL_MS,
  DEFAULT_POLL_BACKOFF_FACTOR,
  MAX_POLL_RETRY_HINTED_DELAY_MS,
  sleep as abortableSleep,
} from "../../internal/retry-transient-rpc.js";
import type { RequestOptions } from "../../public/common.js";
import type { CreateRetryOptions } from "../../public/sandbox.js";
import { parseStatusDetailsFromMetadata } from "./error-info.js";

interface CapacityRetryOptions extends RequestOptions, CreateRetryOptions {
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: typeof abortableSleep;
}

/** Retry only definite capacity rejections. The caller must reuse the create body/key. */
export async function retryCreateCapacity<T>(
  attempt: (timeoutMs: number | undefined) => Promise<T>,
  options: CapacityRetryOptions,
): Promise<T> {
  const budgetMs = options.createRetryBudgetMs ?? 0;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  const deadline = options.timeoutMs === undefined ? undefined : now() + options.timeoutMs;
  let retryDeadline: number | undefined;
  let timeoutMs = options.timeoutMs;
  let delayMs = DEFAULT_POLL_INTERVAL_MS;

  while (true) {
    try {
      return await attempt(timeoutMs);
    } catch (error) {
      if (
        !(error instanceof RpcError) ||
        budgetMs <= 0 ||
        (error.code !== "RESOURCE_EXHAUSTED" && error.code !== "UNAVAILABLE")
      ) {
        throw error;
      }
      const details = parseStatusDetailsFromMetadata(error.meta);
      if (
        details?.domain !== CWSANDBOX_ERROR_DOMAIN ||
        (details.reason !== "CWSANDBOX_RUNNER_CAPACITY_EXHAUSTED" &&
          details.reason !== "CWSANDBOX_RUNNER_OVERLOADED")
      ) {
        throw error;
      }
      retryDeadline ??= Math.min(now() + budgetMs, deadline ?? Infinity);
      const remainingMs = retryDeadline - now();
      if (remainingMs <= 0) {
        throw error;
      }
      const hint = details.retryDelayMs;
      delayMs =
        hint !== undefined && hint > 0
          ? Math.min(hint, MAX_POLL_RETRY_HINTED_DELAY_MS)
          : DEFAULT_POLL_INTERVAL_MS +
            random() *
              (Math.max(
                DEFAULT_POLL_INTERVAL_MS,
                Math.min(DEFAULT_MAX_POLL_INTERVAL_MS, delayMs * DEFAULT_POLL_BACKOFF_FACTOR),
              ) -
                DEFAULT_POLL_INTERVAL_MS);
      try {
        await sleep(Math.min(delayMs, remainingMs), options.signal);
        options.signal?.throwIfAborted();
      } catch (cause) {
        const cancelled = new RpcError("Create cancelled during capacity retry", "CANCELLED");
        cancelled.cause = cause;
        throw cancelled;
      }
      timeoutMs = retryDeadline - now();
      if (timeoutMs <= 0) {
        throw error;
      }
    }
  }
}
