// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxFileError, CWSandboxValidationError } from "../errors.js";
import { CWSANDBOX_FILE_TOO_LARGE } from "../internal/error-info.js";
import {
  isFileTooLargeReason,
  shouldFallbackRead,
  shouldFallbackWrite,
} from "../internal/file-fallback-signals.js";
import {
  MAX_AUTO_FALLBACK_BYTES,
  fileOperationCapBytes,
  recordObservedFileOpCap,
} from "../internal/file-limits.js";
import {
  notifyStreamingFallbackOnce,
  readFileViaStreamExec,
  writeFileViaStreamExec,
} from "../internal/file-stream-fallback.js";
import { readFileStream, writeFileStream, type FileChunkSource } from "../internal/file-stream.js";
import {
  normalizeFileContent,
  normalizeFileWrites,
  validateFileWrites,
  validateReadPaths,
} from "../internal/mounted-files.js";
import { validateRequestOptions } from "../internal/validation/index.js";
import type { RequestOptions } from "../public/common.js";
import type {
  FileContent,
  FileReadResult,
  FileTextReadResult,
  FileWrites,
  SandboxFiles,
} from "../public/files.js";
import type { SandboxRuntime } from "./context.js";

const textDecoder = new TextDecoder();

export function createSandboxFiles(runtime: SandboxRuntime): SandboxFiles {
  return {
    read: readFile.bind(undefined, runtime) as SandboxFiles["read"],
    readStream: (path, options) => readStreamingFile(runtime, path, options),
    readText: readTextFile.bind(undefined, runtime) as SandboxFiles["readText"],
    write: writeFile.bind(undefined, runtime) as SandboxFiles["write"],
    writeStream: (path, source, options) => writeStreamingFile(runtime, path, source, options),
  };
}

function readStreamingFile(
  runtime: SandboxRuntime,
  path: string,
  options: RequestOptions = {},
): AsyncIterable<Uint8Array> {
  validateRequestOptions(options);
  if (typeof path !== "string" || path.length === 0) {
    throw new CWSandboxValidationError("readStream path must be a non-empty string.");
  }
  return readFileStream(runtime, path, options);
}

async function writeStreamingFile(
  runtime: SandboxRuntime,
  path: string,
  source: FileChunkSource,
  options: RequestOptions = {},
): Promise<void> {
  validateRequestOptions(options);
  if (typeof path !== "string" || path.length === 0) {
    throw new CWSandboxValidationError("writeStream path must be a non-empty string.");
  }
  await writeFileStream(runtime, path, source, options);
}

function readFile(
  runtime: SandboxRuntime,
  path: string,
  options?: RequestOptions,
): Promise<Uint8Array>;
function readFile(
  runtime: SandboxRuntime,
  paths: readonly string[],
  options?: RequestOptions,
): Promise<FileReadResult>;
async function readFile(
  runtime: SandboxRuntime,
  pathOrPaths: string | readonly string[],
  options: RequestOptions = {},
): Promise<FileReadResult | Uint8Array> {
  validateRequestOptions(options);

  if (typeof pathOrPaths !== "string") {
    validateReadPaths(pathOrPaths);
    return readEntries(
      await Promise.all(
        pathOrPaths.map(async (path) => [path, await readSingleFile(runtime, path, options)]),
      ),
    );
  }

  return readSingleFile(runtime, pathOrPaths, options);
}

function readTextFile(
  runtime: SandboxRuntime,
  path: string,
  options?: RequestOptions,
): Promise<string>;
function readTextFile(
  runtime: SandboxRuntime,
  paths: readonly string[],
  options?: RequestOptions,
): Promise<FileTextReadResult>;
async function readTextFile(
  runtime: SandboxRuntime,
  pathOrPaths: string | readonly string[],
  options: RequestOptions = {},
): Promise<FileTextReadResult | string> {
  validateRequestOptions(options);

  if (typeof pathOrPaths === "string") {
    return textDecoder.decode(await readSingleFile(runtime, pathOrPaths, options));
  }

  validateReadPaths(pathOrPaths);
  return readTextEntries(
    await Promise.all(
      pathOrPaths.map(async (path) => [
        path,
        textDecoder.decode(await readSingleFile(runtime, path, options)),
      ]),
    ),
  );
}

async function readSingleFile(
  runtime: SandboxRuntime,
  path: string,
  options: RequestOptions = {},
): Promise<Uint8Array> {
  try {
    const result = await runtime.transport.readFile({
      ...options,
      path,
      sandboxId: runtime.sandboxId,
    });
    return result.content;
  } catch (error) {
    if (isFileTooLargeReason(error)) {
      recordObservedFileOpCap(runtime, error);
    }

    const decision = shouldFallbackRead(error);
    if (!decision.fallback) {
      throw error;
    }

    notifyStreamingFallbackOnce(runtime, "Read file", path, decision.expectedSize ?? 0);
    return readFileViaStreamExec(runtime, path, options, decision.expectedSize);
  }
}

async function writeFile(
  runtime: SandboxRuntime,
  path: string,
  content: FileContent,
  options?: RequestOptions,
): Promise<void>;
async function writeFile(
  runtime: SandboxRuntime,
  files: FileWrites,
  options?: RequestOptions,
): Promise<void>;
async function writeFile(
  runtime: SandboxRuntime,
  pathOrFiles: FileWrites | string,
  contentOrOptions?: FileContent | RequestOptions,
  maybeOptions: RequestOptions = {},
): Promise<void> {
  if (typeof pathOrFiles !== "string") {
    const options = contentOrOptions as RequestOptions | undefined;
    validateRequestOptions(options ?? {});
    validateFileWrites(pathOrFiles);
    await Promise.all(
      normalizeFileWrites(pathOrFiles).map((file) =>
        writeSingleFile(runtime, file.path, file.content, options ?? {}),
      ),
    );
    return;
  }

  await writeSingleFile(runtime, pathOrFiles, contentOrOptions as FileContent, maybeOptions);
}

async function writeSingleFile(
  runtime: SandboxRuntime,
  path: string,
  content: FileContent,
  options: RequestOptions = {},
): Promise<void> {
  validateRequestOptions(options);

  const bytes = normalizeFileContent(content);
  const size = bytes.byteLength;

  if (size > MAX_AUTO_FALLBACK_BYTES) {
    throw new CWSandboxFileError(
      `Refusing to write '${path}': ${size} bytes exceeds the ` +
        `auto-fallback ceiling of ${MAX_AUTO_FALLBACK_BYTES} bytes.`,
      {
        filepath: path,
        metadata: {
          filepath: path,
          max_size_bytes: String(MAX_AUTO_FALLBACK_BYTES),
          operation: "write_file",
          size_bytes: String(size),
        },
        operation: "Write file",
        reason: CWSANDBOX_FILE_TOO_LARGE,
        sandboxId: runtime.sandboxId,
      },
    );
  }

  const cap = fileOperationCapBytes(runtime.observedFileOpCapBytes);
  if (size > cap) {
    notifyStreamingFallbackOnce(runtime, "Write file", path, size);
    await writeFileViaStreamExec(runtime, path, bytes, options);
    return;
  }

  try {
    await runtime.transport.writeFile({
      ...options,
      content: bytes,
      path,
      sandboxId: runtime.sandboxId,
    });
  } catch (error) {
    if (isFileTooLargeReason(error)) {
      recordObservedFileOpCap(runtime, error);
    }

    if (!shouldFallbackWrite(error, size)) {
      throw error;
    }

    notifyStreamingFallbackOnce(runtime, "Write file", path, size);
    await writeFileViaStreamExec(runtime, path, bytes, options);
  }
}

function readEntries(entries: readonly (readonly [string, Uint8Array])[]): FileReadResult {
  return Object.fromEntries(entries);
}

function readTextEntries(entries: readonly (readonly [string, string])[]): FileTextReadResult {
  return Object.fromEntries(entries);
}
