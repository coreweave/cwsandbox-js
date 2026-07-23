// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export const DEFAULT_KEEP_ALIVE_COMMAND = [
  "/bin/sh",
  "-lc",
  "trap 'exit 0' TERM INT; sleep infinity & wait",
] as const;

/** Overall wall-clock budget for `listSandboxes()` / `listAll()` when `timeoutMs` is omitted. */
export const DEFAULT_LIST_ALL_TIMEOUT_MS = 300_000;

/** Maximum pages followed by `listSandboxes()` / `listAll()` before failing. */
export const MAX_LIST_ALL_PAGES = 100;
