// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxNotFoundError,
  CWSandboxTerminalStateUnavailableError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
} from "../errors.js";
import {
  DEFAULT_MAX_POLL_INTERVAL_MS,
  DEFAULT_POLL_BACKOFF_FACTOR,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_RETRY_BUDGET_MS,
  DEFAULT_POLL_RPC_TIMEOUT_MS,
  retryTransientRpc,
  sleep,
  throwIfAborted,
} from "../internal/retry-transient-rpc.js";
import { validateWaitOptions } from "../internal/validation/index.js";
import type { GetSandboxResult, SandboxStatus, WaitOptions } from "../public/sandbox.js";
import type { SandboxRuntime } from "./context.js";

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_TARGET_STATUS = "running";
const NOT_FOUND_AFTER_STOP_RETRY_MS = 2_000;
const TERMINAL_STATUSES = new Set<SandboxStatus>(["completed", "failed", "terminated"]);
const WAIT_OPERATION = "Wait for sandbox";

export interface WaitForSandboxOptions extends WaitOptions {
  /**
   * Initial happy-path poll interval in ms. Defaults to Python-parity 200ms and
   * backs off toward 2s. Test-only escape hatch — not part of public WaitOptions.
   */
  readonly initialIntervalMs?: number;
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

  let intervalMs = options.initialIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const targetStatus = options.targetStatus ?? DEFAULT_WAIT_TARGET_STATUS;
  const deadline =
    options.unbounded === true
      ? undefined
      : Date.now() + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  let notFoundRetryDeadline: number | undefined;

  while (true) {
    throwIfAborted(options.signal);

    let result: GetSandboxResult;
    try {
      result = await getStatusForWait(runtime, options.signal, deadline);
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
      intervalMs = nextPollIntervalMs(intervalMs);
      continue;
    }

    onStatus?.(result);
    const { status } = result;
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
      intervalMs = nextPollIntervalMs(intervalMs);
      continue;
    }

    await sleep(intervalMs, options.signal);
    intervalMs = nextPollIntervalMs(intervalMs);
  }
}

function nextPollIntervalMs(intervalMs: number): number {
  return Math.min(intervalMs * DEFAULT_POLL_BACKOFF_FACTOR, DEFAULT_MAX_POLL_INTERVAL_MS);
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
  deadline: number | undefined,
): Promise<GetSandboxResult> {
  const remainingWaitMs =
    deadline === undefined ? DEFAULT_POLL_RETRY_BUDGET_MS : Math.max(0, deadline - Date.now());
  const budgetMs = Math.min(DEFAULT_POLL_RETRY_BUDGET_MS, remainingWaitMs);

  return retryTransientRpc(
    async () => {
      // Clamp each Get so a wedged RPC cannot overrun the wait deadline or the
      // poll RPC timeout. Floor at 1ms to avoid degenerate zero-timeout calls.
      const remainingMs =
        deadline === undefined ? DEFAULT_POLL_RPC_TIMEOUT_MS : Math.max(1, deadline - Date.now());
      const timeoutMs = Math.min(DEFAULT_POLL_RPC_TIMEOUT_MS, remainingMs);

      return runtime.transport.get({
        ...(signal === undefined ? {} : { signal }),
        sandboxId: runtime.sandboxId,
        timeoutMs,
      });
    },
    {
      budgetMs,
      operation: WAIT_OPERATION,
      ...(signal === undefined ? {} : { signal }),
    },
  );
}
