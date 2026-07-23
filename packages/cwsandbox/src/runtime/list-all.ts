// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { DEFAULT_LIST_ALL_TIMEOUT_MS, MAX_LIST_ALL_PAGES } from "../defaults.js";
import { CWSandboxTimeoutError, CWSandboxTransportError } from "../errors.js";
import type {
  ListAllSandboxesOptions,
  ListSandboxesOptions,
  ListSandboxesResult,
  SandboxInfo,
} from "../public/sandbox.js";

const LIST_OPERATION = "List sandboxes";

export async function* iterateListPages<TSandbox>(
  listPage: (options: ListSandboxesOptions) => Promise<ListSandboxesResult>,
  toSandbox: (info: SandboxInfo) => TSandbox,
  options: ListAllSandboxesOptions = {},
): AsyncGenerator<readonly TSandbox[], void, undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIST_ALL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_LIST_ALL_PAGES; page += 1) {
    options.signal?.throwIfAborted();

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CWSandboxTimeoutError(`${LIST_OPERATION} timed out during pagination.`, {
        operation: LIST_OPERATION,
      });
    }

    const result = await listPage({
      ...options,
      ...(pageToken === undefined ? {} : { pageToken }),
      timeoutMs: remainingMs,
    });

    yield result.sandboxes.map(toSandbox);

    const nextPageToken = result.nextPageToken;
    if (nextPageToken === undefined || nextPageToken === "") {
      return;
    }

    if (seenTokens.has(nextPageToken)) {
      throw new CWSandboxTransportError(
        `${LIST_OPERATION} pagination loop detected: repeated page token.`,
        { operation: LIST_OPERATION },
      );
    }

    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  throw new CWSandboxTransportError(
    `${LIST_OPERATION} pagination exceeded ${MAX_LIST_ALL_PAGES} pages.`,
    { operation: LIST_OPERATION },
  );
}

export async function listAllFromPages<TSandbox>(
  listPage: (options: ListSandboxesOptions) => Promise<ListSandboxesResult>,
  toSandbox: (info: SandboxInfo) => TSandbox,
  options: ListAllSandboxesOptions = {},
): Promise<readonly TSandbox[]> {
  const sandboxes: TSandbox[] = [];

  for await (const page of iterateListPages(listPage, toSandbox, options)) {
    sandboxes.push(...page);
  }

  return sandboxes;
}
