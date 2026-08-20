// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxFailedError,
  CWSandboxNotFoundError,
  CWSandboxTerminatedError,
  CWSandboxTerminalStateUnavailableError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
} from "../errors.js";
import {
  DEFAULT_MAX_POLL_INTERVAL_MS,
  DEFAULT_POLL_BACKOFF_FACTOR,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_RETRY_BUDGET_MS,
  retryTransientRpc,
  sleep as defaultSleep,
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
/** Python EXIT_CODE_GRACE_POLLS: runner batches exit_code on a ~5s flush. */
const EXIT_CODE_GRACE_POLLS = 2;
const EXIT_CODE_GRACE_POLL_INTERVAL_MS = 2_000;
const EXIT_CODE_GRACE_RPC_TIMEOUT_MS = 2_000;

export interface WaitForSandboxOptions extends WaitOptions {
  /**
   * Initial happy-path poll interval in ms. Defaults to Python-parity 200ms and
   * backs off toward 2s. Test-only escape hatch — not part of public WaitOptions.
   */
  readonly initialIntervalMs?: number;
  /**
   * Test-only clock. Defaults to `Date.now`. Used for wait deadlines and retry budget.
   */
  readonly now?: () => number;
  /**
   * Soft-retry `CWSandboxNotFoundError` for ~2s, then throw
   * `CWSandboxTerminalStateUnavailableError`. Used by stop-owned waits only.
   */
  readonly retryNotFoundAfterStop?: boolean;
  /**
   * Test-only RNG in `[0, 1)` for retry jitter. Defaults to `Math.random`.
   */
  readonly random?: () => number;
  /**
   * Test-only sleep. Defaults to abort-aware `setTimeout` sleep.
   */
  readonly sleep?: (timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>;
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

  const now = options.now ?? Date.now;
  const sleepFn = options.sleep ?? defaultSleep;
  let intervalMs = options.initialIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const targetStatus = options.targetStatus ?? DEFAULT_WAIT_TARGET_STATUS;
  const deadline =
    options.unbounded === true ? undefined : now() + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  let notFoundRetryDeadline: number | undefined;

  while (true) {
    throwIfAborted(options.signal);

    let result: GetSandboxResult;
    try {
      result = await getStatusForWait(runtime, deadline, options, now);
      notFoundRetryDeadline = undefined;
    } catch (error) {
      if (!(error instanceof CWSandboxNotFoundError) || options.retryNotFoundAfterStop !== true) {
        throw error;
      }

      const current = now();
      if (notFoundRetryDeadline === undefined) {
        notFoundRetryDeadline = current + NOT_FOUND_AFTER_STOP_RETRY_MS;
      }
      if (current >= notFoundRetryDeadline) {
        throw new CWSandboxTerminalStateUnavailableError(
          `Stop succeeded for sandbox '${runtime.sandboxId}', but backend did not report terminal state within ${(NOT_FOUND_AFTER_STOP_RETRY_MS / 1_000).toFixed(1)}s. The terminal outcome (completed or failed) is not observable from the client.`,
          {
            operation: WAIT_OPERATION,
            sandboxId: runtime.sandboxId,
          },
        );
      }

      const remainingNotFoundMs = notFoundRetryDeadline - current;
      const remainingDeadlineMs =
        deadline === undefined
          ? remainingNotFoundMs
          : Math.min(remainingNotFoundMs, deadline - current);
      if (remainingDeadlineMs <= 0) {
        throw new CWSandboxTimeoutError(
          `Timed out waiting for sandbox '${runtime.sandboxId}' to reach status '${targetStatus}'.`,
          {
            operation: WAIT_OPERATION,
            sandboxId: runtime.sandboxId,
          },
        );
      }

      await sleepFn(Math.min(intervalMs, remainingDeadlineMs), options.signal);
      intervalMs = nextPollIntervalMs(intervalMs);
      continue;
    }

    onStatus?.(result);
    const reachedTarget = isWaitTargetReached(result.status, targetStatus);
    const completedDuringRunningWait = targetStatus === "running" && result.status === "completed";
    if (reachedTarget || completedDuringRunningWait) {
      result = await graceRepollForExitCode(
        runtime,
        result,
        options,
        deadline,
        now,
        sleepFn,
        onStatus,
      );
      onStatus?.(result);
    }

    const { status } = result;
    if (isWaitTargetReached(status, targetStatus)) {
      return;
    }

    if (targetStatus === "running") {
      // Python wait-until-running: completed during startup succeeds; failed/terminated
      // raise typed errors; terminating drains toward a real terminal.
      if (status === "completed") {
        return;
      }
      if (status === "failed") {
        throw new CWSandboxFailedError(`Sandbox '${runtime.sandboxId}' failed to start`, {
          operation: WAIT_OPERATION,
          sandboxId: runtime.sandboxId,
        });
      }
      if (status === "terminated") {
        throw new CWSandboxTerminatedError(`Sandbox '${runtime.sandboxId}' was terminated`, {
          operation: WAIT_OPERATION,
          sandboxId: runtime.sandboxId,
        });
      }
      // terminating / creating / pending: keep polling
    } else if (
      targetStatus !== "terminal" &&
      status !== undefined &&
      TERMINAL_STATUSES.has(status)
    ) {
      throw new CWSandboxTransportError(
        `Sandbox '${runtime.sandboxId}' reached terminal status '${status}' before '${targetStatus}'.`,
        {
          operation: WAIT_OPERATION,
          sandboxId: runtime.sandboxId,
        },
      );
    }

    if (deadline !== undefined) {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw new CWSandboxTimeoutError(
          `Timed out waiting for sandbox '${runtime.sandboxId}' to reach status '${targetStatus}'.`,
          {
            operation: WAIT_OPERATION,
            sandboxId: runtime.sandboxId,
          },
        );
      }

      await sleepFn(Math.min(intervalMs, remainingMs), options.signal);
      intervalMs = nextPollIntervalMs(intervalMs);
      continue;
    }

    await sleepFn(intervalMs, options.signal);
    intervalMs = nextPollIntervalMs(intervalMs);
  }
}

function nextPollIntervalMs(intervalMs: number): number {
  return Math.min(intervalMs * DEFAULT_POLL_BACKOFF_FACTOR, DEFAULT_MAX_POLL_INTERVAL_MS);
}

function shouldGraceRepollExitCode(
  result: GetSandboxResult,
  options: WaitForSandboxOptions,
): boolean {
  return (
    options.retryNotFoundAfterStop !== true &&
    result.status === "completed" &&
    result.exitCode === undefined
  );
}

/**
 * Best-effort enrichment when wait observes COMPLETED before the runner's
 * batched exit_code stamp. Stop-owned waits skip this: gateway-initiated
 * stops never stamp a code.
 */
async function graceRepollForExitCode(
  runtime: SandboxRuntime,
  result: GetSandboxResult,
  options: WaitForSandboxOptions,
  deadline: number | undefined,
  now: () => number,
  sleepFn: NonNullable<WaitForSandboxOptions["sleep"]>,
  onStatus: ((metadata: GetSandboxResult) => void) | undefined,
): Promise<GetSandboxResult> {
  if (!shouldGraceRepollExitCode(result, options)) {
    return result;
  }

  let current = result;
  for (let attempt = 0; attempt < EXIT_CODE_GRACE_POLLS; attempt += 1) {
    throwIfAborted(options.signal);
    if (!shouldGraceRepollExitCode(current, options)) {
      return current;
    }

    if (deadline !== undefined) {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        return current;
      }
      await sleepFn(Math.min(EXIT_CODE_GRACE_POLL_INTERVAL_MS, remainingMs), options.signal);
      if (now() >= deadline) {
        return current;
      }
    } else {
      await sleepFn(EXIT_CODE_GRACE_POLL_INTERVAL_MS, options.signal);
    }

    throwIfAborted(options.signal);
    if (!shouldGraceRepollExitCode(current, options)) {
      return current;
    }

    try {
      const remainingMs =
        deadline === undefined ? EXIT_CODE_GRACE_RPC_TIMEOUT_MS : deadline - now();
      if (remainingMs <= 0) {
        return current;
      }
      const bonus = await runtime.transport.get({
        sandboxId: runtime.sandboxId,
        timeoutMs: Math.min(EXIT_CODE_GRACE_RPC_TIMEOUT_MS, remainingMs),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (bonus.status === "completed") {
        current = bonus;
        onStatus?.(current);
      }
    } catch {
      return current;
    }
  }

  return current;
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

  // Python `_RUNNING_STATUSES = {RUNNING, PAUSED}` for wait-until-running.
  if (targetStatus === "running") {
    return status === "running" || status === "paused";
  }

  return status === targetStatus;
}

async function getStatusForWait(
  runtime: SandboxRuntime,
  deadline: number | undefined,
  options: WaitForSandboxOptions,
  now: () => number,
): Promise<GetSandboxResult> {
  if (deadline !== undefined && now() >= deadline) {
    throwWaitTimeout(runtime.sandboxId, options.targetStatus);
  }

  try {
    return await retryTransientRpc(
      async ({ timeoutMs }) =>
        runtime.transport.get({
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          sandboxId: runtime.sandboxId,
          timeoutMs,
        }),
      {
        budgetMs: DEFAULT_POLL_RETRY_BUDGET_MS,
        operation: WAIT_OPERATION,
        now,
        ...(deadline === undefined ? {} : { deadline }),
        ...(options.random === undefined ? {} : { random: options.random }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      },
    );
  } catch (error) {
    // Outer wait shield (Python wait_for): wait wall clock wins over last transient.
    if (deadline !== undefined && now() >= deadline) {
      throwWaitTimeout(runtime.sandboxId, options.targetStatus);
    }
    throw error;
  }
}

function throwWaitTimeout(sandboxId: string, targetStatus: WaitOptions["targetStatus"]): never {
  throw new CWSandboxTimeoutError(
    `Timed out waiting for sandbox '${sandboxId}' to reach status '${targetStatus ?? DEFAULT_WAIT_TARGET_STATUS}'.`,
    {
      operation: WAIT_OPERATION,
      sandboxId,
    },
  );
}
