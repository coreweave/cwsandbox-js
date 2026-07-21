// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../errors.js";
import type { ResourceOptions, ResourceSpec } from "../public/resources.js";

const RESOURCE_KEYS = ["cpu", "memory"] as const;

export function validateResources(resources: ResourceOptions | undefined): void {
  if (resources === undefined) {
    return;
  }

  if (isAdvancedResources(resources)) {
    if ("cpu" in resources || "memory" in resources) {
      throw new CWSandboxValidationError("resources cannot mix cpu/memory with requests/limits");
    }

    if (!("requests" in resources) || !("limits" in resources)) {
      throw new CWSandboxValidationError("resources must include both requests and limits");
    }

    validateResourceSpec(resources.requests, "resources.requests");
    validateResourceSpec(resources.limits, "resources.limits");
    return;
  }

  validateResourceSpec(resources, "resources");
}

export function isAdvancedResources(
  resources: ResourceOptions,
): resources is { readonly limits: ResourceSpec; readonly requests: ResourceSpec } {
  return "requests" in resources || "limits" in resources;
}

export function validateResourceSpec(spec: ResourceSpec, fieldName: string): void {
  if (Object.keys(spec).length === 0) {
    throw new CWSandboxValidationError(`${fieldName} must not be empty`);
  }

  for (const key of RESOURCE_KEYS) {
    const value = spec[key];
    if (value === undefined) {
      continue;
    }

    if (value === "") {
      throw new CWSandboxValidationError(`${fieldName}.${key} must not be empty`);
    }
  }
}
