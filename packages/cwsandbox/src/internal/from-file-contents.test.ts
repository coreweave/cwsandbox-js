// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError, isCWSandboxError } from "../errors.js";
import {
  CREATE_FROM_FILE_CONTENTS_MAX_BYTES,
  readFromFileContents,
  validateFromFileContentsInput,
} from "./from-file-contents.js";

const compose = new TextEncoder().encode("services:\n  main:\n    image: python:3.11\n  \n");

async function withTempDir<TResult>(
  run: (directory: string) => Promise<TResult>,
): Promise<TResult> {
  const directory = await mkdtemp(join(tmpdir(), "cwsandbox-from-file-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function createFifo(path: string): boolean {
  return spawnSync("mkfifo", [path], { encoding: "utf8" }).status === 0;
}

describe("from-file contents", () => {
  it("returns Uint8Array bytes unchanged", async () => {
    await expect(readFromFileContents(compose)).resolves.toEqual(compose);
  });

  it("reads a filesystem path as raw bytes", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "compose.yaml");
      await writeFile(path, compose);
      await expect(readFromFileContents(path)).resolves.toEqual(compose);
    });
  });

  it("treats a string as a path and wraps a missing file as a validation error", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "missing.yaml");
      await expect(
        readFromFileContents("services:\n  main:\n    image: python:3.11\n"),
      ).rejects.toMatchObject({
        cause: { code: "ENOENT" },
        code: "validation_error",
        name: "CWSandboxValidationError",
      });
      await expect(readFromFileContents(path)).rejects.toMatchObject({
        cause: { code: "ENOENT" },
        code: "validation_error",
        message: expect.stringContaining(path),
        name: "CWSandboxValidationError",
      });
      await expect(readFromFileContents(path)).rejects.toSatisfy((error: unknown) =>
        isCWSandboxError(error),
      );
    });
  });

  it("rejects empty or non-path contents", () => {
    expect(() => validateFromFileContentsInput("")).toThrow(CWSandboxValidationError);
    expect(() => validateFromFileContentsInput("   ")).toThrow(CWSandboxValidationError);
    expect(() => validateFromFileContentsInput(1)).toThrow(CWSandboxValidationError);
  });

  it("rejects a directory path", async () => {
    await withTempDir(async (directory) => {
      await expect(readFromFileContents(directory)).rejects.toThrow(CWSandboxValidationError);
      await expect(readFromFileContents(directory)).rejects.toThrow(/regular file/);
    });
  });

  it("rejects contents over 256 KiB", async () => {
    const oversized = new Uint8Array(CREATE_FROM_FILE_CONTENTS_MAX_BYTES + 1);
    await expect(readFromFileContents(oversized)).rejects.toThrow(/256 KiB/);
  });

  it("rejects an oversized path before returning bytes", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "compose.yaml");
      await writeFile(path, new Uint8Array(CREATE_FROM_FILE_CONTENTS_MAX_BYTES + 1));
      await expect(readFromFileContents(path)).rejects.toThrow(/256 KiB/);
    });
  });

  it("reads a path at the 256 KiB limit", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "compose.yaml");
      const exact = new Uint8Array(CREATE_FROM_FILE_CONTENTS_MAX_BYTES);
      await writeFile(path, exact);
      await expect(readFromFileContents(path)).resolves.toEqual(exact);
    });
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO path before reading", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "compose.fifo");
      expect(createFifo(path)).toBe(true);
      await expect(readFromFileContents(path)).rejects.toBeInstanceOf(CWSandboxValidationError);
      await expect(readFromFileContents(path)).rejects.toThrow(/regular file/);
    });
  });

  it("honors an already-aborted signal before reading a path", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "compose.yaml");
      await writeFile(path, compose);
      const controller = new AbortController();
      const reason = new Error("cancelled");
      controller.abort(reason);
      await expect(readFromFileContents(path, { signal: controller.signal })).rejects.toBe(reason);
    });
  });
});
