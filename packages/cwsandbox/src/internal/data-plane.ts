// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../errors.js";
import { DATA_PLANE_MODES, type DataPlaneMode } from "../public/common.js";

export const DEFAULT_DATA_PLANE_MODE: DataPlaneMode = "auto";

const DATA_PLANE_MODE_SET: ReadonlySet<string> = new Set(DATA_PLANE_MODES);

export function validateDataPlaneMode(value: DataPlaneMode | undefined): void {
  if (value === undefined) {
    return;
  }
  if (!DATA_PLANE_MODE_SET.has(value)) {
    throw new CWSandboxValidationError(
      `dataPlaneMode must be ${DATA_PLANE_MODES.join(", ")}, got ${JSON.stringify(value)}.`,
    );
  }
}

export function resolveDataPlaneMode(
  override: DataPlaneMode | undefined,
  clientDefault: DataPlaneMode = DEFAULT_DATA_PLANE_MODE,
): DataPlaneMode {
  return override ?? clientDefault;
}
