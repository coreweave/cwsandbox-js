// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { SandboxId } from "../public/sandbox.js";
import type { SandboxTransport } from "../transport.js";

export interface SandboxRuntime {
  readonly sandboxId: SandboxId;
  readonly transport: SandboxTransport;
  /**
   * Server-reported unary file cap from `FILE_TOO_LARGE` `max_size_bytes`.
   * Raw value; clamp at use via `fileOperationCapBytes`.
   */
  observedFileOpCapBytes: number | undefined;
  /** One-shot INFO log when StreamExec file fallback first fires on this sandbox. */
  streamingFallbackNotified: boolean;
}
