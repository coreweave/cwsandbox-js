// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export type Milliseconds = number;
export type Seconds = number;

/**
 * How exec, logs, and file RPCs reach the sandbox.
 *
 * `auto` (default) tries a one-second direct mTLS setup, then the API gateway.
 * `direct` requires mTLS and never falls back. `gateway` is today's Bearer path.
 * Create, inspect, stop, and snapshots always use the gateway.
 */
export type DataPlaneMode = "auto" | "direct" | "gateway";

export const DATA_PLANE_MODES = ["auto", "direct", "gateway"] as const;

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: Milliseconds;
}
