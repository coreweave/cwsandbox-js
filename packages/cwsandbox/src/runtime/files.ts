// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../errors.js";
import { MAX_CONCURRENT_FILE_REQUESTS_PER_BATCH } from "../internal/file-limits.js";
import { mapWithConcurrency } from "../internal/map-concurrency.js";
import {
  normalizeFileContent,
  normalizeFileWrites,
  validateFileWrites,
  validateReadPaths,
} from "../internal/mounted-files.js";
import { validateRequestOptions } from "../internal/validation/index.js";
import type { RequestOptions } from "../public/common.js";
import type {
  FileChunkSource,
  FileContent,
  FileReadResult,
  FileTextReadResult,
  FileWrites,
  SandboxFiles,
} from "../public/files.js";
import type { FileTransfer } from "./file-transfer.js";

const textDecoder = new TextDecoder();

export function createSandboxFiles(fileTransfer: FileTransfer): SandboxFiles {
  return {
    read: readFile.bind(undefined, fileTransfer) as SandboxFiles["read"],
    readStream: (path, options) => readStreamingFile(fileTransfer, path, options),
    readText: readTextFile.bind(undefined, fileTransfer) as SandboxFiles["readText"],
    write: writeFile.bind(undefined, fileTransfer) as SandboxFiles["write"],
    writeStream: (path, source, options) => writeStreamingFile(fileTransfer, path, source, options),
  };
}

function readStreamingFile(
  fileTransfer: FileTransfer,
  path: string,
  options: RequestOptions = {},
): AsyncIterable<Uint8Array> {
  validateRequestOptions(options);
  if (typeof path !== "string" || path.length === 0) {
    throw new CWSandboxValidationError("readStream path must be a non-empty string.");
  }
  return fileTransfer.readStream(path, options);
}

async function writeStreamingFile(
  fileTransfer: FileTransfer,
  path: string,
  source: FileChunkSource,
  options: RequestOptions = {},
): Promise<void> {
  validateRequestOptions(options);
  if (typeof path !== "string" || path.length === 0) {
    throw new CWSandboxValidationError("writeStream path must be a non-empty string.");
  }
  await fileTransfer.writeStream(path, source, options);
}

function readFile(
  fileTransfer: FileTransfer,
  path: string,
  options?: RequestOptions,
): Promise<Uint8Array>;
function readFile(
  fileTransfer: FileTransfer,
  paths: readonly string[],
  options?: RequestOptions,
): Promise<FileReadResult>;
async function readFile(
  fileTransfer: FileTransfer,
  pathOrPaths: string | readonly string[],
  options: RequestOptions = {},
): Promise<FileReadResult | Uint8Array> {
  validateRequestOptions(options);

  if (typeof pathOrPaths !== "string") {
    validateReadPaths(pathOrPaths);
    return readEntries(
      await mapWithConcurrency(
        pathOrPaths,
        MAX_CONCURRENT_FILE_REQUESTS_PER_BATCH,
        async (path) => [path, await fileTransfer.readSingle(path, options)],
      ),
    );
  }

  return fileTransfer.readSingle(pathOrPaths, options);
}

function readTextFile(
  fileTransfer: FileTransfer,
  path: string,
  options?: RequestOptions,
): Promise<string>;
function readTextFile(
  fileTransfer: FileTransfer,
  paths: readonly string[],
  options?: RequestOptions,
): Promise<FileTextReadResult>;
async function readTextFile(
  fileTransfer: FileTransfer,
  pathOrPaths: string | readonly string[],
  options: RequestOptions = {},
): Promise<FileTextReadResult | string> {
  validateRequestOptions(options);

  if (typeof pathOrPaths === "string") {
    return textDecoder.decode(await fileTransfer.readSingle(pathOrPaths, options));
  }

  validateReadPaths(pathOrPaths);
  return readTextEntries(
    await mapWithConcurrency(pathOrPaths, MAX_CONCURRENT_FILE_REQUESTS_PER_BATCH, async (path) => [
      path,
      textDecoder.decode(await fileTransfer.readSingle(path, options)),
    ]),
  );
}

async function writeFile(
  fileTransfer: FileTransfer,
  path: string,
  content: FileContent,
  options?: RequestOptions,
): Promise<void>;
async function writeFile(
  fileTransfer: FileTransfer,
  files: FileWrites,
  options?: RequestOptions,
): Promise<void>;
async function writeFile(
  fileTransfer: FileTransfer,
  pathOrFiles: FileWrites | string,
  contentOrOptions?: FileContent | RequestOptions,
  maybeOptions: RequestOptions = {},
): Promise<void> {
  if (typeof pathOrFiles !== "string") {
    const options = contentOrOptions as RequestOptions | undefined;
    validateRequestOptions(options ?? {});
    validateFileWrites(pathOrFiles);
    await mapWithConcurrency(
      normalizeFileWrites(pathOrFiles),
      MAX_CONCURRENT_FILE_REQUESTS_PER_BATCH,
      async (file) => {
        await fileTransfer.writeSingle(
          file.path,
          normalizeFileContent(file.content),
          options ?? {},
        );
      },
    );
    return;
  }

  validateRequestOptions(maybeOptions);
  await fileTransfer.writeSingle(
    pathOrFiles,
    normalizeFileContent(contentOrOptions as FileContent),
    maybeOptions,
  );
}

function readEntries(entries: readonly (readonly [string, Uint8Array])[]): FileReadResult {
  return Object.fromEntries(entries);
}

function readTextEntries(entries: readonly (readonly [string, string])[]): FileTextReadResult {
  return Object.fromEntries(entries);
}
