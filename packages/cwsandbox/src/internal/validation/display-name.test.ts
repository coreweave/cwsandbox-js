// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError } from "../../errors.js";
import { validateDisplayName } from "./display-name.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("validateDisplayName", () => {
  it.each([
    undefined,
    "",
    "my-box",
    "My Box 1",
    "a".repeat(128),
    "é".repeat(64),
    "名前",
    "x​",
    "x﻿",
    UUID.slice(1),
    `${UUID}x`,
    `é${UUID}x`,
  ])("accepts %j", (name) => {
    expect(() => validateDisplayName(name)).not.toThrow();
  });

  it.each([
    "a".repeat(129),
    "é".repeat(65),
    " leading",
    "trailing ",
    "\ttab",
    "nbsp ",
    "　ideographic",
    "a/b",
    "a\\b",
    "a:b",
    "nul\u0000",
    "del\u007f",
    "c1\u0085",
    "lone\ud800",
    UUID,
    UUID.toUpperCase(),
    UUID.replaceAll("-", ""),
    `{${UUID}}`,
    `x${UUID}y`,
    `urn:uuid:${UUID}`,
  ])("rejects %j", (name) => {
    expect(() => validateDisplayName(name)).toThrow(CWSandboxValidationError);
  });

  it("rejects non-strings", () => {
    expect(() => validateDisplayName(42 as unknown as string)).toThrow(
      "displayName must be a string.",
    );
  });
});
