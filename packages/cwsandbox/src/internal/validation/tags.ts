// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../../errors.js";
import type { SandboxTag } from "../../public/sandbox.js";
import { validateUniqueStringList } from "./string-list.js";

const SANDBOX_TAG_PATTERN = /^[A-Za-z0-9._-]*[A-Za-z0-9]$/;
const SANDBOX_TAG_RULE =
  "tags may contain letters, numbers, '.', '_' or '-', must be 59 characters or fewer, must end with a letter or number, and may start with '.', '_' or '-'";

export function validateTags(tags: readonly SandboxTag[] | undefined): void {
  validateUniqueStringList(tags, "tags");

  if (tags === undefined) {
    return;
  }

  for (const tag of tags) {
    if (tag.length > 59 || !SANDBOX_TAG_PATTERN.test(tag)) {
      throw new CWSandboxValidationError(
        `tags contains invalid value: ${tag}. ${SANDBOX_TAG_RULE}`,
      );
    }
  }
}
