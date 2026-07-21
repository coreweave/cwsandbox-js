// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../../errors.js";
import type { SandboxAnnotations } from "../../public/sandbox.js";

export function validateAnnotations(annotations: SandboxAnnotations | undefined): void {
  if (annotations === undefined) {
    return;
  }

  if (annotations === null || typeof annotations !== "object" || Array.isArray(annotations)) {
    throw new CWSandboxValidationError("annotations must be an object of string values");
  }

  const entries = Object.entries(annotations);
  if (entries.length > 100) {
    throw new CWSandboxValidationError("annotations must contain 100 entries or fewer");
  }

  for (const [key, value] of entries) {
    if (key === "") {
      throw new CWSandboxValidationError("annotations must not contain empty keys");
    }

    if (typeof value !== "string") {
      throw new CWSandboxValidationError(`annotations["${key}"] must be a string`);
    }

    if (value === "") {
      throw new CWSandboxValidationError(`annotations["${key}"] must not be empty`);
    }
  }
}
