// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { randomUUID } from "node:crypto";

import { DEFAULT_SNAPSHOT_TIMEOUT_MS, SNAPSHOT_OBSERVATION_SLACK_MS } from "../defaults.js";
import { CWSandboxTimeoutError, CWSandboxTransportError } from "../errors.js";
import {
  DEFAULT_MAX_POLL_INTERVAL_MS,
  DEFAULT_POLL_BACKOFF_FACTOR,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_RETRY_BUDGET_MS,
  retryTransientRpc,
  sleep as defaultSleep,
  throwIfAborted,
} from "../internal/retry-transient-rpc.js";
import { validateRequestOptions } from "../internal/validation/index.js";
import type { RequestOptions } from "../public/common.js";
import type { FileSystemSnapshotResult, GetSandboxResult } from "../public/sandbox.js";
import type { FileSystemSnapshotRecord } from "../transport/types.js";
import type { SandboxRuntime } from "./context.js";
import { waitForSandbox } from "./wait.js";

const SNAPSHOT_OPERATION = "Create file-system snapshot";
const GET_SNAPSHOT_OPERATION = "Get file-system snapshot";

export interface CaptureFileSystemSnapshotOptions extends RequestOptions {
  /**
   * Initial happy-path poll interval in ms. Defaults to Python-parity 200ms and
   * backs off toward 2s. Test-only escape hatch — not part of public RequestOptions.
   */
  readonly initialIntervalMs?: number;
  /**
   * Test-only clock. Defaults to `Date.now`. Used for snapshot deadlines and retry budget.
   */
  readonly now?: () => number;
  /**
   * Test-only RNG in `[0, 1)` for retry jitter. Defaults to `Math.random`.
   */
  readonly random?: () => number;
  /**
   * Test-only sleep. Defaults to abort-aware `setTimeout` sleep.
   */
  readonly sleep?: (timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>;
}

export async function captureFileSystemSnapshot(
  runtime: SandboxRuntime,
  options: CaptureFileSystemSnapshotOptions = {},
  onStatus?: (metadata: GetSandboxResult) => void,
): Promise<FileSystemSnapshotResult> {
  validateRequestOptions(options);

  const now = options.now ?? Date.now;
  const sleepFn = options.sleep ?? defaultSleep;

  await waitForSandbox(
    runtime,
    {
      ...(options.initialIntervalMs === undefined
        ? {}
        : { initialIntervalMs: options.initialIntervalMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    },
    onStatus,
  );

  const deadline =
    now() + (options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS) + SNAPSHOT_OBSERVATION_SLACK_MS;
  const requestId = randomUUID();
  const created = await createSnapshot(runtime, requestId, options, now, deadline);
  return waitForSnapshotReady(runtime, created.snapshotId, options, now, sleepFn, deadline);
}

async function createSnapshot(
  runtime: SandboxRuntime,
  requestId: string,
  options: CaptureFileSystemSnapshotOptions,
  now: () => number,
  deadline: number,
): Promise<FileSystemSnapshotRecord> {
  if (now() >= deadline) {
    throwSnapshotTimeout(runtime.sandboxId);
  }

  try {
    return await retryTransientRpc(
      async ({ timeoutMs }) =>
        runtime.transport.createFileSystemSnapshot({
          requestId,
          sandboxId: runtime.sandboxId,
          timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      {
        budgetMs: DEFAULT_POLL_RETRY_BUDGET_MS,
        deadline,
        nonRetryable: [CWSandboxTimeoutError],
        operation: SNAPSHOT_OPERATION,
        now,
        ...(options.random === undefined ? {} : { random: options.random }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      },
    );
  } catch (error) {
    if (now() >= deadline) {
      throwSnapshotTimeout(runtime.sandboxId);
    }
    throw error;
  }
}

async function waitForSnapshotReady(
  runtime: SandboxRuntime,
  snapshotId: string,
  options: CaptureFileSystemSnapshotOptions,
  now: () => number,
  sleepFn: NonNullable<CaptureFileSystemSnapshotOptions["sleep"]>,
  deadline: number,
): Promise<FileSystemSnapshotResult> {
  let intervalMs = options.initialIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  while (true) {
    throwIfAborted(options.signal);

    const record = await getSnapshot(runtime, snapshotId, options, now, deadline);
    if (record.state === "ready") {
      return {
        snapshotId: record.snapshotId,
        ...(record.sizeBytes === undefined ? {} : { sizeBytes: record.sizeBytes }),
      };
    }
    if (record.state === "failed") {
      const reason = record.stateReason === undefined ? "" : `: ${record.stateReason}`;
      throw new CWSandboxTransportError(`File-system snapshot '${snapshotId}' failed${reason}.`, {
        operation: SNAPSHOT_OPERATION,
        sandboxId: runtime.sandboxId,
        ...(record.stateReason === undefined ? {} : { reason: record.stateReason }),
      });
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throwSnapshotTimeout(runtime.sandboxId, snapshotId);
    }

    await sleepFn(Math.min(intervalMs, remainingMs), options.signal);
    intervalMs = Math.min(intervalMs * DEFAULT_POLL_BACKOFF_FACTOR, DEFAULT_MAX_POLL_INTERVAL_MS);
  }
}

async function getSnapshot(
  runtime: SandboxRuntime,
  snapshotId: string,
  options: CaptureFileSystemSnapshotOptions,
  now: () => number,
  deadline: number,
): Promise<FileSystemSnapshotRecord> {
  if (now() >= deadline) {
    throwSnapshotTimeout(runtime.sandboxId, snapshotId);
  }

  try {
    return await retryTransientRpc(
      async ({ timeoutMs }) =>
        runtime.transport.getFileSystemSnapshot({
          snapshotId,
          timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      {
        budgetMs: DEFAULT_POLL_RETRY_BUDGET_MS,
        deadline,
        operation: GET_SNAPSHOT_OPERATION,
        now,
        ...(options.random === undefined ? {} : { random: options.random }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      },
    );
  } catch (error) {
    if (now() >= deadline) {
      throwSnapshotTimeout(runtime.sandboxId, snapshotId);
    }
    throw error;
  }
}

function throwSnapshotTimeout(sandboxId: string, snapshotId?: string): never {
  throw new CWSandboxTimeoutError(
    snapshotId === undefined
      ? `Timed out creating a file-system snapshot for sandbox '${sandboxId}'.`
      : `Timed out waiting for file-system snapshot '${snapshotId}' to become ready.`,
    {
      operation: SNAPSHOT_OPERATION,
      sandboxId,
    },
  );
}
