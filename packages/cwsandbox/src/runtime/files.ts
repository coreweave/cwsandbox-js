// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

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
    readText: readTextFile.bind(undefined, runtime) as SandboxFiles["readText"],
    write: writeFile.bind(undefined, runtime) as SandboxFiles["write"],
  };
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
  const result = await runtime.transport.readFile({
    ...options,
    path,
    sandboxId: runtime.sandboxId,
  });

  return result.content;
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

  await runtime.transport.writeFile({
    ...options,
    content: normalizeFileContent(content),
    path,
    sandboxId: runtime.sandboxId,
  });
}

function readEntries(entries: readonly (readonly [string, Uint8Array])[]): FileReadResult {
  return Object.fromEntries(entries);
}

function readTextEntries(entries: readonly (readonly [string, string])[]): FileTextReadResult {
  return Object.fromEntries(entries);
}
