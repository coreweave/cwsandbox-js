// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export const DEFAULT_KEEP_ALIVE_COMMAND = [
  "/bin/sh",
  "-lc",
  "trap 'exit 0' TERM INT; sleep infinity & wait",
] as const;

/** Default stop grace period in seconds when `gracefulShutdownSeconds` is omitted. */
export const DEFAULT_GRACEFUL_SHUTDOWN_SECONDS = 10 as const;

/** Overall wall-clock budget for `listSandboxes()` / `listAll()` when `timeoutMs` is omitted. */
export const DEFAULT_LIST_ALL_TIMEOUT_MS = 300_000;

/** Maximum pages followed by `listSandboxes()` / `listAll()` before failing. */
export const MAX_LIST_ALL_PAGES = 100;

/** Scratch volume name for the convenience `fileSystemSnapshot` create option. */
export const DEFAULT_SCRATCH_VOLUME_NAME = "workspace" as const;

/**
 * Public default `snapshot()` wait budget (Aviato archive timeout / Python
 * `DEFAULT_FSS_STOP_TIMEOUT_SECONDS`).
 */
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 600_000 as const;

/**
 * Extra client deadline beyond the archive budget so Get can observe READY
 * after an archive that finishes at t=600s (Python
 * `DEFAULT_CLIENT_TIMEOUT_BUFFER_SECONDS`).
 */
export const SNAPSHOT_OBSERVATION_SLACK_MS = 5_000 as const;
