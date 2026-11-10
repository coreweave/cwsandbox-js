// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { RequestOptions } from "./common.js";

export type FileContent = string | Uint8Array;
export type FileReadResult = Readonly<Record<string, Uint8Array>>;
export type FileTextReadResult = Readonly<Record<string, string>>;
export type FileWrites = readonly FileWrite[] | Readonly<Record<string, FileContent>>;
export type MountedFileContent = string | Uint8Array;
export type MountedFiles = readonly MountedFile[] | Readonly<Record<string, MountedFileContent>>;

/** Chunk source for `files.writeStream` (no Web/Node stream types in v1). */
export type FileChunkSource = Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

export interface FileOptions extends RequestOptions {
  /** Target container name. Omit or empty for the primary. */
  readonly container?: string;
}

export interface MountedFile {
  readonly content: MountedFileContent;
  readonly path: string;
}

export interface FileWrite {
  readonly content: FileContent;
  readonly path: string;
}

export interface SandboxFiles {
  read(path: string, options?: FileOptions): Promise<Uint8Array>;
  read(paths: readonly string[], options?: FileOptions): Promise<FileReadResult>;
  /**
   * Incrementally read a remote file as binary chunks. Prefer this over
   * buffered `read` for large files. Drain promptly to avoid stream backpressure.
   *
   * `timeoutMs` is one wall-clock budget for the integrity `stat` and the
   * file transfer combined. The clock starts when iteration begins.
   */
  readStream(path: string, options?: FileOptions): AsyncIterable<Uint8Array>;
  readText(path: string, options?: FileOptions): Promise<string>;
  readText(paths: readonly string[], options?: FileOptions): Promise<FileTextReadResult>;
  write(path: string, content: FileContent, options?: FileOptions): Promise<void>;
  write(files: FileWrites, options?: FileOptions): Promise<void>;
  /**
   * Incrementally write a remote file from a buffer or chunk iterable.
   * A mid-stream failure or abort may leave a partial remote file.
   */
  writeStream(path: string, source: FileChunkSource, options?: FileOptions): Promise<void>;
}
