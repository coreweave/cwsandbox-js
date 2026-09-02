// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { DataPlaneMode } from "../public/data-plane.js";
import type { SandboxId } from "../public/sandbox.js";
import type { SandboxTransport } from "../transport.js";

export interface SandboxRuntime {
  readonly dataPlaneMode?: DataPlaneMode;
  readonly sandboxId: SandboxId;
  readonly transport: SandboxTransport;
  /** Scratch names from this-process create only. Omitted for fromId / list. */
  readonly scratchVolumeNames?: readonly string[];
}
