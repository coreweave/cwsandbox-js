// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../errors.js";
import type {
  GpuSpec,
  ResourceOptions,
  ResourceRequestsAndLimits,
  ResourceSpec,
} from "../public/resources.js";

const RESOURCE_KEYS = ["cpu", "memory"] as const;
const GPU_KEYS: ReadonlySet<string> = new Set(["count", "type", "memoryGb"]);

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
    for (const side of ["requests", "limits"] as const) {
      if ((resources[side] as ResourceSpec).gpu !== undefined) {
        throw new CWSandboxValidationError(
          `resources.${side}.gpu is not supported; set resources.gpu instead`,
        );
      }
    }
    validateGpuSpec(resources.gpu, "resources.gpu");
    return;
  }

  validateResourceSpec(resources, "resources");
  validateGpuSpec(resources.gpu, "resources.gpu");
}

export function isAdvancedResources(
  resources: ResourceOptions,
): resources is ResourceRequestsAndLimits {
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

function validateGpuSpec(gpu: GpuSpec | undefined, fieldName: string): void {
  if (gpu === undefined) {
    return;
  }
  if (gpu === null || typeof gpu !== "object" || Array.isArray(gpu)) {
    throw new CWSandboxValidationError(`${fieldName} must be an object`);
  }
  for (const key of Object.keys(gpu)) {
    if (!GPU_KEYS.has(key)) {
      throw new CWSandboxValidationError(`${fieldName}.${key} is not a recognized GPU option`);
    }
  }
  validatePositiveInteger(gpu.count, `${fieldName}.count`);
  if (gpu.type !== undefined && (typeof gpu.type !== "string" || gpu.type === "")) {
    throw new CWSandboxValidationError(`${fieldName}.type must be a non-empty string`);
  }
  if (gpu.memoryGb !== undefined) {
    validatePositiveInteger(gpu.memoryGb, `${fieldName}.memoryGb`);
    if (gpu.type !== undefined) {
      throw new CWSandboxValidationError(`${fieldName} must not set both type and memoryGb`);
    }
  }
}

function validatePositiveInteger(value: unknown, fieldName: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CWSandboxValidationError(`${fieldName} must be a positive integer`);
  }
}
