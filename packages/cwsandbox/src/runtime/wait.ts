// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
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
const TERMINAL_STATUSES = new Set<SandboxStatus>(["completed", "failed", "terminated"]);
const WAIT_OPERATION = "Wait for sandbox";

export async function waitForSandbox(
  runtime: SandboxRuntime,
  options: WaitOptions = {},
  onStatus?: (metadata: GetSandboxResult) => void,
): Promise<void> {
  validateWaitOptions(options);

  const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const targetStatus = options.targetStatus ?? DEFAULT_WAIT_TARGET_STATUS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    throwIfAborted(options.signal);

    const result = await getStatusForWait(runtime, options.signal);
    if (result !== undefined) {
      onStatus?.(result);
    }
    const status = result?.status;
    if (status === targetStatus) {
      return;
    }

    if (status !== undefined && TERMINAL_STATUSES.has(status)) {
      throw new CWSandboxTransportError(
        `Sandbox '${runtime.sandboxId}' reached terminal status '${status}' before '${targetStatus}'.`,
        {
          operation: WAIT_OPERATION,
          sandboxId: runtime.sandboxId,
        },
      );
    }

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
  }
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
