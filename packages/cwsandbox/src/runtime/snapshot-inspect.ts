// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { DEFAULT_LIST_ALL_TIMEOUT_MS, MAX_LIST_ALL_PAGES } from "../defaults.js";
import { CWSandboxTimeoutError, CWSandboxTransportError } from "../errors.js";
import {
  DEFAULT_POLL_RETRY_BUDGET_MS,
  retryTransientRpc,
} from "../internal/retry-transient-rpc.js";
import {
  validateListSnapshotsOptions,
  validateRequestOptions,
  validateSnapshotId,
} from "../internal/validation/index.js";
import type { RequestOptions } from "../public/common.js";
import type { FileSystemSnapshotResult, ListSnapshotsOptions } from "../public/sandbox.js";
import type { SandboxTransport } from "../transport.js";
import { getFileSystemSnapshotRecord } from "./snapshot.js";

const LIST_SNAPSHOTS_OPERATION = "List file-system snapshots";

/**
 * List is a different algorithm from capture: token loop, then client-side
 * filters. Get delegates to `getFileSystemSnapshotRecord`.
 */
export async function getSnapshotRecord(
  transport: SandboxTransport,
  snapshotId: string,
  options: RequestOptions = {},
): Promise<FileSystemSnapshotResult> {
  validateSnapshotId(snapshotId);
  validateRequestOptions(options);

  return getFileSystemSnapshotRecord(transport, snapshotId, {
    nonRetryable: [CWSandboxTimeoutError],
    rpcTimeoutMs: options.timeoutMs ?? DEFAULT_LIST_ALL_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export async function listSnapshotRecords(
  transport: SandboxTransport,
  options: ListSnapshotsOptions = {},
): Promise<readonly FileSystemSnapshotResult[]> {
  validateListSnapshotsOptions(options);

  const overallTimeoutMs = options.timeoutMs ?? DEFAULT_LIST_ALL_TIMEOUT_MS;
  const deadline = Date.now() + overallTimeoutMs;
  const seenTokens = new Set<string>();
  const snapshots: FileSystemSnapshotResult[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_LIST_ALL_PAGES; page += 1) {
    options.signal?.throwIfAborted();

    const result = await retryTransientRpc(
      async () => {
        const pageTimeoutMs = deadline - Date.now();
        if (pageTimeoutMs <= 0) {
          throw new CWSandboxTimeoutError(
            `${LIST_SNAPSHOTS_OPERATION} timed out during pagination.`,
            { operation: LIST_SNAPSHOTS_OPERATION },
          );
        }
        return transport.listFileSystemSnapshots({
          timeoutMs: pageTimeoutMs,
          ...(pageToken === undefined ? {} : { pageToken }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      },
      {
        budgetMs: DEFAULT_POLL_RETRY_BUDGET_MS,
        deadline,
        nonRetryable: [CWSandboxTimeoutError],
        operation: LIST_SNAPSHOTS_OPERATION,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );

    snapshots.push(...result.snapshots);

    const nextPageToken = result.nextPageToken;
    if (nextPageToken === undefined || nextPageToken === "") {
      return applySnapshotFilters(snapshots, options);
    }

    if (seenTokens.has(nextPageToken)) {
      throw new CWSandboxTransportError(
        `${LIST_SNAPSHOTS_OPERATION} pagination loop detected: repeated page token.`,
        { operation: LIST_SNAPSHOTS_OPERATION },
      );
    }

    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  throw new CWSandboxTransportError(
    `${LIST_SNAPSHOTS_OPERATION} pagination exceeded ${MAX_LIST_ALL_PAGES} pages.`,
    { operation: LIST_SNAPSHOTS_OPERATION },
  );
}

function applySnapshotFilters(
  snapshots: readonly FileSystemSnapshotResult[],
  options: ListSnapshotsOptions,
): readonly FileSystemSnapshotResult[] {
  return snapshots.filter((snapshot) => {
    if (
      options.sourceSandboxId !== undefined &&
      snapshot.sourceSandboxId !== options.sourceSandboxId
    ) {
      return false;
    }
    if (options.state !== undefined && snapshot.state !== options.state) {
      return false;
    }
    return true;
  });
}
