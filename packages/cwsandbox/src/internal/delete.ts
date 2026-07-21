// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxNotFoundError } from "../errors.js";

export async function ignoreMissingSandbox(deleteOperation: Promise<void>): Promise<void> {
  try {
    await deleteOperation;
  } catch (error) {
    if (error instanceof CWSandboxNotFoundError) {
      return;
    }

    throw error;
  }
}
