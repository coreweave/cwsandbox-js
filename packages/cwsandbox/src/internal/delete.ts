// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { isSandboxNotFound } from "./error-info.js";

/**
 * Await a delete (or equivalent) operation, swallowing sandbox-not-found when
 * `missingOk` is true.
 */
export async function ignoreMissingSandbox(
  deleteOperation: Promise<void>,
  missingOk: boolean = false,
): Promise<void> {
  try {
    await deleteOperation;
  } catch (error) {
    if (missingOk && isSandboxNotFound(error)) {
      return;
    }

    throw error;
  }
}
