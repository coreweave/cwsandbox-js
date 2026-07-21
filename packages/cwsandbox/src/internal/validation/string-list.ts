// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../../errors.js";

export function validateUniqueStringList(
  values: readonly string[] | undefined,
  name: string,
): void {
  if (values === undefined) {
    return;
  }

  if (!Array.isArray(values)) {
    throw new CWSandboxValidationError(`${name} must be an array of strings`);
  }

  const seen = new Set<string>();

  for (const value of values) {
    if (typeof value !== "string") {
      throw new CWSandboxValidationError(`${name} must contain only strings`);
    }

    if (value === "") {
      throw new CWSandboxValidationError(`${name} must not contain empty values`);
    }

    if (seen.has(value)) {
      throw new CWSandboxValidationError(`${name} contains duplicate value: ${value}`);
    }

    seen.add(value);
  }
}
