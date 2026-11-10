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

export interface DirectoryUploadProgress {
  /** Source file bytes staged in the sandbox so far. */
  readonly bytesDone: number;
  /** Total size of the regular files being uploaded. */
  readonly bytesTotal: number;
}

export interface DirectoryUploadOptions extends FileOptions {
  /**
   * Glob patterns to leave out. A pattern without `/` matches any single name
   * (`".git"`, `"*.pyc"`); a pattern with `/` matches the path relative to the
   * local directory (`"build/*.o"`). Excluded directories are not walked.
   * Nothing is excluded by default, including `.git`.
   */
  readonly exclude?: readonly string[];
  /** Gzip the archive (needs `gzip` in the image). Defaults to `true`. */
  readonly compress?: boolean;
  /** Called after each 32 MiB part is staged in the sandbox, and once at the end. */
  readonly onProgress?: (progress: DirectoryUploadProgress) => void;
}

/** Summary of a completed `files.uploadDirectory` call. */
export interface DirectoryUploadResult {
  /** Regular files uploaded. */
  readonly files: number;
  /** Directories uploaded, not counting the root. */
  readonly directories: number;
  /** Symbolic links uploaded (stored as links, not followed). */
  readonly symlinks: number;
  /** Total size of the regular files. */
  readonly bytes: number;
  /** Size of the archive sent (compressed unless `compress: false`). */
  readonly archiveBytes: number;
  /** SHA256 hex digest of the archive, verified in the sandbox. */
  readonly sha256: string;
  /** Archive bytes an earlier interrupted call had already staged and this call did not resend. */
  readonly resumedBytes: number;
  /** Relative paths of sockets, FIFOs and device files, which are not uploaded. */
  readonly skipped: readonly string[];
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
  /**
   * Upload a local directory tree into `remotePath` (created if missing), so
   * its contents land inside it like `cp -r local/. remote/`. Remote files at
   * the same paths are overwritten; other remote files are kept.
   *
   * The SDK streams a deterministic tar (gzip by default) in 32 MiB parts to
   * `remotePath/.cwsandbox-upload-<key>/`, checks each part's size and SHA256
   * as it arrives and the whole archive before `tar` extracts it, and retries
   * a failed part up to 3 times. If the call still fails or is interrupted,
   * staged parts are kept, and calling again on the unchanged tree sends only
   * the missing parts (`resumedBytes`). Staging untouched for 24 hours is
   * removed by later uploads into the same directory.
   *
   * Symbolic links are uploaded as links; a link that is absolute or points
   * outside the tree fails with stage `archive` (exclude it to upload the
   * rest). Permission bits and mtimes are kept; ownership, setuid, setgid and
   * sticky bits are not. Sockets, FIFOs and devices are listed in `skipped`.
   *
   * `timeoutMs` is an overall deadline (none by default). Failures of the
   * upload itself throw `CWSandboxFileError` with `metadata.stage` set to
   * `archive`, `preflight` (missing tools in `metadata.missing_tools`, or an
   * unwritable `remotePath`), `transfer`, `verify` (`remotePath` unchanged)
   * or `extract` (`remotePath` may be partly updated). The sandbox needs
   * `/bin/sh`, `tar`, `sha256sum`, `head`, `wc`, `cat`, `mv`, `rm`, `mkdir`
   * and, when compressing, `gzip`. Node.js only.
   */
  uploadDirectory(
    localPath: string,
    remotePath: string,
    options?: DirectoryUploadOptions,
  ): Promise<DirectoryUploadResult>;
}
