// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { DataPlaneMode, RequestOptions } from "../public/common.js";
import type { FileChunkSource } from "../public/files.js";
import type { SandboxId } from "../public/sandbox.js";

export type { FileChunkSource };

export interface ReadFileRequest extends RequestOptions {
  readonly dataPlaneMode?: DataPlaneMode;
  readonly path: string;
  readonly sandboxId: SandboxId;
}

export interface ReadFileResult {
  readonly content: Uint8Array;
}

export interface WriteFileRequest extends RequestOptions {
  readonly content: Uint8Array;
  readonly dataPlaneMode?: DataPlaneMode;
  readonly path: string;
  readonly sandboxId: SandboxId;
}

export interface ReadStreamRequest extends RequestOptions {
  readonly dataPlaneMode?: DataPlaneMode;
  readonly path: string;
  readonly sandboxId: SandboxId;
  /**
   * Pre-read size from a buffered `files.read` fallback (`FILE_TOO_LARGE`
   * `size_bytes`). When set, skip the integrity `stat` StreamExec.
   */
  readonly expectedSize?: number;
}

export interface WriteStreamRequest extends RequestOptions {
  readonly dataPlaneMode?: DataPlaneMode;
  /**
   * `'direct'` for `files.writeStream` — a mid-stream error may leave a partial
   * file.  `'atomic'` for the buffered `files.write` StreamExec fallback —
   * writes to a sibling temp file, verifies byte count, then renames.
   */
  readonly mode: "atomic" | "direct";
  readonly path: string;
  readonly sandboxId: SandboxId;
  readonly source: FileChunkSource;
  /** Required for `atomic` mode — shell verify step checks actual === expected. */
  readonly expectedBytes?: number;
}

/** Low-level file I/O.  No gRPC or command-runtime concepts. */
export interface FileAdapter {
  read(request: ReadFileRequest): Promise<ReadFileResult>;
  write(request: WriteFileRequest): Promise<void>;
  readStream(request: ReadStreamRequest): AsyncIterable<Uint8Array>;
  writeStream(request: WriteStreamRequest): Promise<void>;
}
