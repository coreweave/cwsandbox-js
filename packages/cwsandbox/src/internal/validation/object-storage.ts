// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../../errors.js";
import type { SandboxObjectStorageAccess } from "../../public/sandbox.js";
import { validateUniqueStringList } from "./string-list.js";

const MAX_OBJECT_PREFIX_BYTES = 512;
const OBJECT_PREFIX_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*\/$/;

/**
 * Gateway `ValidateSandboxObjectPrefix` (OSA tokens only).
 */
export function validateObjectPrefix(
  prefix: string | undefined,
  field = "objectStorageAccess.objectPrefix",
): void {
  if (prefix === undefined || prefix === "") {
    return;
  }
  if (new TextEncoder().encode(prefix).byteLength > MAX_OBJECT_PREFIX_BYTES) {
    throw new CWSandboxValidationError(
      `${field} must be at most ${MAX_OBJECT_PREFIX_BYTES} bytes.`,
    );
  }
  if (!OBJECT_PREFIX_RE.test(prefix)) {
    throw new CWSandboxValidationError(
      `${field} must start alphanumeric, contain only [a-zA-Z0-9._/-], and end with '/'.`,
    );
  }
  if (prefix.includes("..") || prefix.includes("//")) {
    throw new CWSandboxValidationError(`${field} must not contain '..' or '//'.`);
  }
}

export function validateObjectStorageAccess(access: SandboxObjectStorageAccess | undefined): void {
  if (access === undefined) {
    return;
  }

  validateUniqueStringList(access.buckets, "objectStorageAccess.buckets");
  if (access.buckets === undefined || access.buckets.length === 0) {
    throw new CWSandboxValidationError("objectStorageAccess.buckets must not be empty.");
  }
  if (access.permission !== "read" && access.permission !== "read-write") {
    throw new CWSandboxValidationError(
      'objectStorageAccess.permission must be "read" or "read-write".',
    );
  }
  if (access.objectPrefix !== undefined && typeof access.objectPrefix !== "string") {
    throw new CWSandboxValidationError("objectStorageAccess.objectPrefix must be a string.");
  }
  validateObjectPrefix(access.objectPrefix);
}
