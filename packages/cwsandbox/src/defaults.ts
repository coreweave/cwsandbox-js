// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export const DEFAULT_KEEP_ALIVE_COMMAND = [
  "/bin/sh",
  "-lc",
  "trap 'exit 0' TERM INT; sleep infinity & wait",
] as const;
