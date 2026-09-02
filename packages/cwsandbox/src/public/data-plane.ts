// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/** Transport policy for exec, logs, and file operations. */
export type DataPlaneMode = "auto" | "direct" | "gateway";

export interface DataPlaneOptions {
  /**
   * `auto` prefers a sandbox-scoped direct mTLS connection and falls back to
   * the gateway. `direct` requires that connection. Defaults to `auto`.
   */
  readonly dataPlaneMode?: DataPlaneMode;
}
