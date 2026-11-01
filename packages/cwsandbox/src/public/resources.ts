// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export type ResourceOptions = ResourceSpec | ResourceRequestsAndLimits;

export interface ResourceSpec {
  readonly cpu?: string;
  readonly memory?: string;
  readonly gpu?: GpuSpec;
}

/**
 * GPU is set once for the container, next to `requests` and `limits`, because
 * GPUs cannot be overcommitted.
 */
export interface ResourceRequestsAndLimits {
  readonly limits: Omit<ResourceSpec, "gpu">;
  readonly requests: Omit<ResourceSpec, "gpu">;
  readonly gpu?: GpuSpec;
}

/**
 * GPU allocation. Select a GPU by `type` (for example `"H100"`) or by minimum
 * VRAM with `memoryGb`, not both. Omit both to accept any GPU. Capacity and
 * type availability are checked by the server.
 */
export interface GpuSpec {
  /** Number of GPUs. Positive integer. */
  readonly count: number;
  readonly type?: string;
  /** Minimum GPU memory in GB. Positive integer. */
  readonly memoryGb?: number;
}
