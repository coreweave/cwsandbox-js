// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../../errors.js";
import type {
  CreateNetworkConfigOptions,
  DeleteNetworkConfigOptions,
  ListNetworkConfigsOptions,
  NetworkConfigUpdateField,
  UpdateNetworkConfigOptions,
} from "../../public/network-config.js";
import type { NetworkOptions } from "../../public/network.js";
import { validateNetworkOptions } from "../network.js";
import { validateRequestOptions } from "./index.js";

const UPDATE_FIELDS: ReadonlySet<string> = new Set<NetworkConfigUpdateField>([
  "denyEgress",
  "denyIngress",
  "dnsEgress",
  "egress",
]);

export function validateCreateNetworkConfigOptions(options: CreateNetworkConfigOptions): void {
  validateRequestOptions(options);
  validateNetworkOptions(undefined, options.network);
  if (options.requestId !== undefined) {
    if (typeof options.requestId !== "string" || options.requestId.trim() === "") {
      throw new CWSandboxValidationError("requestId must not be empty.");
    }
  }
}

export function validateListNetworkConfigsOptions(options: ListNetworkConfigsOptions): void {
  validateRequestOptions(options);
  if (options.platformManaged !== undefined && typeof options.platformManaged !== "boolean") {
    throw new CWSandboxValidationError("platformManaged must be a boolean.");
  }
}

export function validateDeleteNetworkConfigOptions(options: DeleteNetworkConfigOptions): void {
  validateRequestOptions(options);
  if (options.missingOk !== undefined && typeof options.missingOk !== "boolean") {
    throw new CWSandboxValidationError("missingOk must be a boolean.");
  }
}

export function validateUpdateNetworkConfigOptions(
  network: NetworkOptions,
  options: UpdateNetworkConfigOptions,
): void {
  if (network === null || typeof network !== "object" || Array.isArray(network)) {
    throw new CWSandboxValidationError("network must be an object.");
  }
  validateRequestOptions(options);
  validateNetworkOptions(undefined, network);
  if (options.etag !== undefined && (typeof options.etag !== "string" || options.etag === "")) {
    throw new CWSandboxValidationError("etag must not be empty.");
  }
  const mask = options.updateMask as unknown;
  if (mask === undefined) {
    return;
  }
  if (!Array.isArray(mask)) {
    throw new CWSandboxValidationError("updateMask must be an array.");
  }
  for (const field of mask) {
    if (typeof field !== "string" || !UPDATE_FIELDS.has(field)) {
      throw new CWSandboxValidationError(
        `updateMask entries must be "denyEgress", "denyIngress", "dnsEgress", or "egress"; got ${JSON.stringify(field)}.`,
      );
    }
  }
}
