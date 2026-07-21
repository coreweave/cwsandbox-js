// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError } from "./errors.js";
import { commandForWorkingDirectory, normalizeCommand } from "./internal/commands.js";

describe("normalizeCommand", () => {
  it("returns a non-empty command tuple from a dynamic array", () => {
    const command: string[] = ["node", "--version"];

    expect(normalizeCommand(command)).toEqual(["node", "--version"]);
  });

  it("throws a typed validation error for an empty command", () => {
    expect(() => normalizeCommand([])).toThrow(CWSandboxValidationError);
  });

  it("throws a typed validation error for a blank executable", () => {
    expect(() => normalizeCommand(["   "])).toThrow(CWSandboxValidationError);
  });
});

describe("commandForWorkingDirectory", () => {
  it("returns the command unchanged without cwd", () => {
    expect(commandForWorkingDirectory(["node", "--version"], undefined)).toEqual([
      "node",
      "--version",
    ]);
  });

  it("wraps commands with shell-safe cwd and argument quoting", () => {
    expect(commandForWorkingDirectory(["cat", "file's name.txt"], "/tmp/quoted dir")).toEqual([
      "/bin/sh",
      "-lc",
      "cd '/tmp/quoted dir' && exec 'cat' 'file'\\''s name.txt'",
    ]);
  });
});
