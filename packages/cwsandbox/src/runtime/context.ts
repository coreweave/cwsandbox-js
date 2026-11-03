// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { DataPlaneMode } from "../public/data-plane.js";
import type { SandboxExecStats, SandboxId } from "../public/sandbox.js";
import type { SandboxTransport } from "../transport.js";

export type ExecStatsCounter = { -readonly [K in keyof SandboxExecStats]: number };

export interface SandboxRuntime {
  readonly dataPlaneMode?: DataPlaneMode;
  /** Mutated by `execCommand`; backs `Sandbox.execStats`. */
  readonly execStats?: ExecStatsCounter;
  readonly sandboxId: SandboxId;
  readonly transport: SandboxTransport;
  /** Scratch names from this-process create only. Omitted for fromId / list. */
  readonly scratchVolumeNames?: readonly string[];
}
