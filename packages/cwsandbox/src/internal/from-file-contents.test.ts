// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CWSandboxTimeoutError, CWSandboxValidationError, isCWSandboxError } from "../errors.js";
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

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO that delivers more than 256 KiB",
    async () => {
      await withTempDir(async (directory) => {
        const path = join(directory, "compose.fifo");
        expect(createFifo(path)).toBe(true);

        const oversized = new Uint8Array(CREATE_FROM_FILE_CONTENTS_MAX_BYTES + 1);
        const pending = readFromFileContents(path);
        const written = writeFile(path, oversized).catch(() => undefined);
        await expect(pending).rejects.toBeInstanceOf(CWSandboxValidationError);
        await expect(pending).rejects.toThrow(/256 KiB/);
        await written;
      });
    },
  );

  it.skipIf(process.platform === "win32")("aborts a blocked FIFO read", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "compose.fifo");
      expect(createFifo(path)).toBe(true);

      const controller = new AbortController();
      const pending = readFromFileContents(path, { signal: controller.signal });
      const reason = new Error("cancelled");
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    });
  });

  it.skipIf(process.platform === "win32")("times out a blocked FIFO read", async () => {
    await withTempDir(async (directory) => {
      const path = join(directory, "compose.fifo");
      expect(createFifo(path)).toBe(true);

      await expect(readFromFileContents(path, { timeoutMs: 25 })).rejects.toBeInstanceOf(
        CWSandboxTimeoutError,
      );
    });
  });
});
