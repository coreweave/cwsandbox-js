// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../../errors.js";
import type { SecurityContext } from "../../public/sandbox.js";
import { validateUniqueStringList } from "./string-list.js";

const MAX_UINT32 = 0xffffffff;

export function validateSecurityContext(context: SecurityContext | undefined): void {
  if (context === undefined) {
    return;
  }
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new CWSandboxValidationError("securityContext must be an object.");
  }

  validateUint32(context.runAsUser, "securityContext.runAsUser");
  validateUint32(context.runAsGroup, "securityContext.runAsGroup");
  validateBoolean(context.privileged, "securityContext.privileged");
  validateBoolean(context.allowPrivilegeEscalation, "securityContext.allowPrivilegeEscalation");
  validateBoolean(context.readOnlyRootFilesystem, "securityContext.readOnlyRootFilesystem");
  validateUniqueStringList(context.capabilitiesAdd, "securityContext.capabilitiesAdd");
  validateUniqueStringList(context.capabilitiesDrop, "securityContext.capabilitiesDrop");
  if (context.seccompProfile !== undefined && typeof context.seccompProfile !== "string") {
    throw new CWSandboxValidationError("securityContext.seccompProfile must be a string.");
  }
}

function validateUint32(value: number | undefined, name: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new CWSandboxValidationError(`${name} must be an unsigned 32-bit integer.`);
  }
}

function validateBoolean(value: boolean | undefined, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new CWSandboxValidationError(`${name} must be a boolean.`);
  }
}
