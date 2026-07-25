// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxTimeoutError } from "../../errors.js";

export const STDIN_READY_TIMEOUT_MS = 5_000;

export interface StdinReadyGate {
  signalFailed(error: unknown): void;
  signalReady(): void;
  wait(timeoutMs: number): Promise<void>;
}

export function createStdinReadyGate(): StdinReadyGate {
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);

  return {
    signalFailed(error) {
      if (settled) {
        return;
      }
      settled = true;
      rejectReady(error);
    },
    signalReady() {
      if (settled) {
        return;
      }
      settled = true;
      resolveReady();
    },
    wait(timeoutMs) {
      if (timeoutMs <= 0) {
        return Promise.reject(
          new CWSandboxTimeoutError("stdin ready signal not received within timeout", {
            operation: "Streaming command",
          }),
        );
      }

      return new Promise<void>((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) {
            return;
          }
          done = true;
          const error = new CWSandboxTimeoutError(
            "stdin ready signal not received within timeout",
            {
              operation: "Streaming command",
            },
          );
          if (!settled) {
            settled = true;
            rejectReady(error);
          }
          reject(error);
        }, timeoutMs);

        void ready.then(
          () => {
            if (done) {
              return;
            }
            done = true;
            clearTimeout(timer);
            resolve();
          },
          (error: unknown) => {
            if (done) {
              return;
            }
            done = true;
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    },
  };
}

/** Python parity: ready wait is min(5s, operation timeout). */
export function stdinReadyTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs === undefined
    ? STDIN_READY_TIMEOUT_MS
    : Math.min(STDIN_READY_TIMEOUT_MS, timeoutMs);
}

/**
 * Wait for stdin ready; on timeout/failure abort the linked RPC so the duplex
 * call does not stay open after the caller sees the error.
 */
export async function awaitStdinReadyOrAbort(
  stdinReady: StdinReadyGate | undefined,
  timeoutMs: number,
  abortController: AbortController,
): Promise<void> {
  if (stdinReady === undefined) {
    return;
  }

  try {
    await stdinReady.wait(timeoutMs);
  } catch (error) {
    abortController.abort(error);
    throw error;
  }
}
