// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../errors.js";

const V1_UNSUPPORTED = "is not supported in v1";

export function rejectUnsupportedFields(options: object, fields: readonly string[]): void {
  const record = options as Record<string, unknown>;
  for (const field of fields) {
    if (record[field] !== undefined) {
      throw new CWSandboxValidationError(`${field} ${V1_UNSUPPORTED}`);
    }
  }
}
