// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../../errors.js";

const MAX_DISPLAY_NAME_BYTES = 128;
const EDGE_WHITESPACE = /^\p{White_Space}|\p{White_Space}$/u;
// Lone surrogates cannot be sent as valid UTF-8.
const FORBIDDEN_CHARACTERS = /[/\\:\p{Cc}\p{Cs}]/u;
const UUID_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// The forms the server's UUID parser accepts. Its 38-byte form does not check
// the wrapping characters, so any ASCII pair counts, not only braces.
const UUID_SHAPE = new RegExp(
  `^(?:${UUID_BODY}|[\\x00-\\x7f]${UUID_BODY}[\\x00-\\x7f]|[0-9a-f]{32})$`,
  "i",
);
const DISPLAY_NAME_RULE =
  "displayName must be at most 128 UTF-8 bytes, without leading or trailing whitespace, slashes, backslashes, colons, control characters, or a UUID value.";

const textEncoder = new TextEncoder();

/** Mirrors the server's display name rules; `""` means unset. */
export function validateDisplayName(displayName: string | undefined): void {
  if (displayName === undefined || displayName === "") {
    return;
  }
  if (typeof displayName !== "string") {
    throw new CWSandboxValidationError("displayName must be a string.");
  }
  if (
    textEncoder.encode(displayName).length > MAX_DISPLAY_NAME_BYTES ||
    EDGE_WHITESPACE.test(displayName) ||
    FORBIDDEN_CHARACTERS.test(displayName) ||
    UUID_SHAPE.test(displayName)
  ) {
    throw new CWSandboxValidationError(DISPLAY_NAME_RULE);
  }
}
