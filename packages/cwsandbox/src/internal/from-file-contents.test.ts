// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError } from "../errors.js";
import {
  CREATE_FROM_FILE_CONTENTS_MAX_BYTES,
  readFromFileContents,
  validateFromFileContentsInput,
} from "./from-file-contents.js";

const compose = new TextEncoder().encode("services:\n  main:\n    image: python:3.11\n  \n");

describe("from-file contents", () => {
  it("returns Uint8Array bytes unchanged", async () => {
    await expect(readFromFileContents(compose)).resolves.toEqual(compose);
  });

  it("reads a filesystem path as raw bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cwsandbox-from-file-"));
    const path = join(directory, "compose.yaml");
    try {
      await writeFile(path, compose);
      await expect(readFromFileContents(path)).resolves.toEqual(compose);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("treats a string as a path, not Compose text", async () => {
    await expect(
      readFromFileContents("services:\n  main:\n    image: python:3.11\n"),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("rejects empty or non-path contents", () => {
    expect(() => validateFromFileContentsInput("")).toThrow(CWSandboxValidationError);
    expect(() => validateFromFileContentsInput("   ")).toThrow(CWSandboxValidationError);
    expect(() => validateFromFileContentsInput(1)).toThrow(CWSandboxValidationError);
  });

  it("rejects contents over 256 KiB", async () => {
    const oversized = new Uint8Array(CREATE_FROM_FILE_CONTENTS_MAX_BYTES + 1);
    await expect(readFromFileContents(oversized)).rejects.toThrow(/256 KiB/);
  });

  it("rejects an oversized path before returning bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cwsandbox-from-file-"));
    const path = join(directory, "compose.yaml");
    try {
      await writeFile(path, new Uint8Array(CREATE_FROM_FILE_CONTENTS_MAX_BYTES + 1));
      await expect(readFromFileContents(path)).rejects.toThrow(/256 KiB/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
