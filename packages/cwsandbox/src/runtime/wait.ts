// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxNotFoundError,
  CWSandboxTerminalStateUnavailableError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
} from "../errors.js";
import { validateWaitOptions } from "../internal/validation/index.js";
import type { GetSandboxResult, SandboxStatus, WaitOptions } from "../public/sandbox.js";
import type { SandboxRuntime } from "./context.js";

const DEFAULT_WAIT_INTERVAL_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_TARGET_STATUS = "running";
const NOT_FOUND_AFTER_STOP_RETRY_MS = 2_000;
const TERMINAL_STATUSES = new Set<SandboxStatus>(["completed", "failed", "terminated"]);
const WAIT_OPERATION = "Wait for sandbox";

export interface WaitForSandboxOptions extends WaitOptions {
  /**
   * Soft-retry `CWSandboxNotFoundError` for ~2s, then throw
   * `CWSandboxTerminalStateUnavailableError`. Used by stop-owned waits only.
   */
  readonly retryNotFoundAfterStop?: boolean;
  /**
   * When true, poll until the target is reached with no wall-clock deadline.
   * Public `sandbox.wait()` keeps the default 60s timeout when this is unset.
   */
  readonly unbounded?: boolean;
}

export async function waitForSandbox(
  runtime: SandboxRuntime,
  options: WaitForSandboxOptions = {},
  onStatus?: (metadata: GetSandboxResult) => void,
): Promise<void> {
  validateWaitOptions(options);

  const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const targetStatus = options.targetStatus ?? DEFAULT_WAIT_TARGET_STATUS;
  const deadline =
    options.unbounded === true
      ? undefined
      : Date.now() + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  let notFoundRetryDeadline: number | undefined;

  while (true) {
    throwIfAborted(options.signal);

    let result: GetSandboxResult | undefined;
    try {
      result = await getStatusForWait(runtime, options.signal);
      notFoundRetryDeadline = undefined;
    } catch (error) {
      if (!(error instanceof CWSandboxNotFoundError) || options.retryNotFoundAfterStop !== true) {
        throw error;
      }

      const now = Date.now();
      if (notFoundRetryDeadline === undefined) {
        notFoundRetryDeadline = now + NOT_FOUND_AFTER_STOP_RETRY_MS;
      }
      if (now >= notFoundRetryDeadline) {
        throw new CWSandboxTerminalStateUnavailableError(
          `Stop succeeded for sandbox '${runtime.sandboxId}', but backend did not report terminal state within ${(NOT_FOUND_AFTER_STOP_RETRY_MS / 1_000).toFixed(1)}s. The terminal outcome (completed or failed) is not observable from the client.`,
          {
            operation: WAIT_OPERATION,
            sandboxId: runtime.sandboxId,
          },
        );
      }

      const remainingNotFoundMs = notFoundRetryDeadline - now;
      const remainingDeadlineMs =
        deadline === undefined
          ? remainingNotFoundMs
          : Math.min(remainingNotFoundMs, deadline - now);
      if (remainingDeadlineMs <= 0) {
        throw new CWSandboxTimeoutError(
          `Timed out waiting for sandbox '${runtime.sandboxId}' to reach status '${targetStatus}'.`,
          {
            operation: WAIT_OPERATION,
            sandboxId: runtime.sandboxId,
          },
        );
      }

      await sleep(Math.min(intervalMs, remainingDeadlineMs), options.signal);
      continue;
    }

    if (result !== undefined) {
      onStatus?.(result);
    }
    const status = result?.status;
    if (isWaitTargetReached(status, targetStatus)) {
      return;
    }

    if (targetStatus !== "terminal" && status !== undefined && TERMINAL_STATUSES.has(status)) {
      throw new CWSandboxTransportError(
        `Sandbox '${runtime.sandboxId}' reached terminal status '${status}' before '${targetStatus}'.`,
        {
          operation: WAIT_OPERATION,
          sandboxId: runtime.sandboxId,
        },
      );
    }

    if (deadline !== undefined) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new CWSandboxTimeoutError(
          `Timed out waiting for sandbox '${runtime.sandboxId}' to reach status '${targetStatus}'.`,
          {
            operation: WAIT_OPERATION,
            sandboxId: runtime.sandboxId,
          },
        );
      }

      await sleep(Math.min(intervalMs, remainingMs), options.signal);
      continue;
    }

    await sleep(intervalMs, options.signal);
  }
}

function isWaitTargetReached(
  status: SandboxStatus | undefined,
  targetStatus: NonNullable<WaitOptions["targetStatus"]>,
): boolean {
  if (status === undefined) {
    return false;
  }

  if (targetStatus === "terminal") {
    return TERMINAL_STATUSES.has(status);
  }

  return status === targetStatus;
}

async function getStatusForWait(
  runtime: SandboxRuntime,
  signal: AbortSignal | undefined,
): Promise<GetSandboxResult | undefined> {
  try {
    return await runtime.transport.get({
      ...(signal === undefined ? {} : { signal }),
      sandboxId: runtime.sandboxId,
    });
  } catch (error) {
    if (error instanceof CWSandboxUnavailableError) {
      return undefined;
    }

    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function sleep(timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
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
