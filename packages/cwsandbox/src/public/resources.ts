// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export type ResourceOptions = ResourceSpec | ResourceRequestsAndLimits;

export interface ResourceSpec {
  readonly cpu?: string;
  readonly memory?: string;
}

export interface ResourceRequestsAndLimits {
  readonly limits: ResourceSpec;
  readonly requests: ResourceSpec;
}
