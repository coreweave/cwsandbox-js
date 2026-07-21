// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { SandboxId } from "../public/sandbox.js";
import type { SandboxTransport } from "../transport.js";

export interface SandboxRuntime {
  readonly sandboxId: SandboxId;
  readonly transport: SandboxTransport;
  /** One-shot INFO log when StreamExec file fallback first fires on this sandbox. */
  streamingFallbackNotified: boolean;
}
