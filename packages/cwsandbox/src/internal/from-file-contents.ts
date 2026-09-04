// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { CWSandboxError, CWSandboxTimeoutError, CWSandboxValidationError } from "../errors.js";

/** Raw Compose YAML cap for create-from-file. The API also enforces this. */
export const CREATE_FROM_FILE_CONTENTS_MAX_BYTES = 256 * 1024;

export interface ReadFromFileContentsOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export function validateFromFileContentsInput(
  contents: unknown,
): asserts contents is string | Uint8Array {
  if (contents instanceof Uint8Array) {
    return;
  }
  if (typeof contents === "string" && contents.trim() !== "") {
    return;
  }
  throw new CWSandboxValidationError(
    "contents must be a non-empty filesystem path or a Uint8Array of file bytes.",
  );
}

function validateFromFileContentsSize(contents: Uint8Array): void {
  if (contents.byteLength > CREATE_FROM_FILE_CONTENTS_MAX_BYTES) {
    throw new CWSandboxValidationError(
      `contents exceeds ${String(CREATE_FROM_FILE_CONTENTS_MAX_BYTES)} bytes (256 KiB).`,
    );
  }
}

function isPreservedReadError(error: unknown): boolean {
  return (
    error instanceof CWSandboxError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

function wrapFromFilePathError(path: string, error: unknown): never {
  if (isPreservedReadError(error)) {
    throw error;
  }
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  const detail = error instanceof Error ? error.message : "unknown error";
  const suffix = typeof code === "string" ? ` (${code})` : "";
  throw new CWSandboxValidationError(`Failed to read contents path "${path}"${suffix}: ${detail}`, {
    cause: error,
  });
}

function combineReadSignals(options: ReadFromFileContentsOptions): {
  readonly cleanup: () => void;
  readonly signal: AbortSignal | undefined;
} {
  if (options.timeoutMs === undefined) {
    return {
      cleanup() {},
      signal: options.signal,
    };
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new CWSandboxTimeoutError("Timed out reading contents path."));
  }, options.timeoutMs);
  timer.unref();
  return {
    cleanup() {
      clearTimeout(timer);
    },
    signal:
      options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([options.signal, timeoutController.signal]),
  };
}

async function readCappedFilePath(
  path: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  signal?.throwIfAborted();

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return wrapFromFilePathError(path, error);
  }

  const abortRead = (): void => {
    void handle.close().catch(() => undefined);
  };
  if (signal !== undefined) {
    signal.addEventListener("abort", abortRead, { once: true });
  }

  try {
    signal?.throwIfAborted();
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new CWSandboxValidationError(`contents path must be a regular file: ${path}`);
    }

    const stream = handle.createReadStream(signal === undefined ? {} : { signal });
    const buffer = new Uint8Array(CREATE_FROM_FILE_CONTENTS_MAX_BYTES + 1);
    let offset = 0;
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      if (offset + bytes.byteLength > CREATE_FROM_FILE_CONTENTS_MAX_BYTES) {
        stream.destroy();
        throw new CWSandboxValidationError(
          `contents exceeds ${String(CREATE_FROM_FILE_CONTENTS_MAX_BYTES)} bytes (256 KiB).`,
        );
      }
      buffer.set(bytes, offset);
      offset += bytes.byteLength;
    }
    signal?.throwIfAborted();
    return Uint8Array.from(buffer.subarray(0, offset));
  } catch (error) {
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    return wrapFromFilePathError(path, error);
  } finally {
    signal?.removeEventListener("abort", abortRead);
    await handle.close().catch(() => undefined);
  }
}

/** Reads path bytes or returns the given `Uint8Array`. Do not log `contents`. */
export async function readFromFileContents(
  contents: string | Uint8Array,
  options: ReadFromFileContentsOptions = {},
): Promise<Uint8Array> {
  validateFromFileContentsInput(contents);
  if (contents instanceof Uint8Array) {
    validateFromFileContentsSize(contents);
    return contents;
  }

  const combined = combineReadSignals(options);
  try {
    return await readCappedFilePath(contents, combined.signal);
  } finally {
    combined.cleanup();
  }
}
