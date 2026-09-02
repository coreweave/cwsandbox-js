// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxFileError, CWSandboxValidationError } from "../errors.js";
import { CWSANDBOX_FILE_TOO_LARGE, CWSANDBOX_FILE_TRUNCATED } from "../internal/error-info.js";
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
import type { RequestOptions } from "../public/common.js";
import type { DataPlaneMode } from "../public/data-plane.js";
import type { FileChunkSource } from "../public/files.js";
import type { SandboxId } from "../public/sandbox.js";
import type { FileAdapter } from "../transport/file-adapter.js";

/** Per-sandbox file transfer state and policy. */
export class FileTransfer {
  /** Raw observed cap from FILE_TOO_LARGE errors; clamp at use via fileOperationCapBytes. */
  observedFileOpCapBytes: number | undefined;
  private streamingFallbackNotified = false;

  public constructor(
    private readonly sandboxId: SandboxId,
    private readonly adapter: FileAdapter,
    private readonly dataPlaneMode?: DataPlaneMode,
  ) {}

  public async readSingle(path: string, options: RequestOptions): Promise<Uint8Array> {
    try {
      const result = await this.adapter.read({
        ...options,
        ...(this.dataPlaneMode === undefined ? {} : { dataPlaneMode: this.dataPlaneMode }),
        path,
        sandboxId: this.sandboxId,
      });
      return result.content;
    } catch (error) {
      if (isFileTooLargeReason(error)) {
        recordObservedFileOpCap(this, error);
      }

      const decision = shouldFallbackRead(error);
      if (!decision.fallback) {
        throw error;
      }

      this.notifyStreamingFallbackOnce("Read file", path, decision.expectedSize ?? 0);
      return this.readViaSingleStreamExec(path, options, decision.expectedSize);
    }
  }

  public async writeSingle(
    path: string,
    bytes: Uint8Array,
    options: RequestOptions,
  ): Promise<void> {
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
          sandboxId: this.sandboxId,
        },
      );
    }

    const cap = fileOperationCapBytes(this.observedFileOpCapBytes);
    if (size > cap) {
      this.notifyStreamingFallbackOnce("Write file", path, size);
      await this.writeViaAtomicStreamExec(path, bytes, options);
      return;
    }

    try {
      await this.adapter.write({
        ...options,
        content: bytes,
        ...(this.dataPlaneMode === undefined ? {} : { dataPlaneMode: this.dataPlaneMode }),
        path,
        sandboxId: this.sandboxId,
      });
    } catch (error) {
      if (isFileTooLargeReason(error)) {
        recordObservedFileOpCap(this, error);
      }

      if (!shouldFallbackWrite(error, size)) {
        throw error;
      }

      this.notifyStreamingFallbackOnce("Write file", path, size);
      await this.writeViaAtomicStreamExec(path, bytes, options);
    }
  }

  public writeStream(
    path: string,
    source: FileChunkSource,
    options: RequestOptions,
  ): Promise<void> {
    return this.adapter.writeStream({
      ...options,
      ...(this.dataPlaneMode === undefined ? {} : { dataPlaneMode: this.dataPlaneMode }),
      mode: "direct",
      path,
      sandboxId: this.sandboxId,
      source: validatedChunkSource(source),
    });
  }

  public readStream(path: string, options: RequestOptions): AsyncIterable<Uint8Array> {
    return this.adapter.readStream({
      ...options,
      ...(this.dataPlaneMode === undefined ? {} : { dataPlaneMode: this.dataPlaneMode }),
      path,
      sandboxId: this.sandboxId,
    });
  }

  private async readViaSingleStreamExec(
    path: string,
    options: RequestOptions,
    expectedSize?: number,
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for await (const chunk of this.adapter.readStream({
      ...options,
      ...(this.dataPlaneMode === undefined ? {} : { dataPlaneMode: this.dataPlaneMode }),
      path,
      sandboxId: this.sandboxId,
      ...(expectedSize === undefined ? {} : { expectedSize }),
    })) {
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }

    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    if (expectedSize !== undefined && expectedSize > 0 && totalBytes < expectedSize) {
      throw new CWSandboxFileError(
        `read_file of '${path}' was truncated: got ${totalBytes} of ${expectedSize} bytes. ` +
          "Read the file in smaller parts.",
        {
          filepath: path,
          metadata: {
            bytes_delivered: String(totalBytes),
            filepath: path,
            operation: "read_file",
            size_bytes: String(expectedSize),
          },
          operation: "Read file",
          reason: CWSANDBOX_FILE_TRUNCATED,
          sandboxId: this.sandboxId,
        },
      );
    }

    return result;
  }

  private async writeViaAtomicStreamExec(
    path: string,
    bytes: Uint8Array,
    options: RequestOptions,
  ): Promise<void> {
    await this.adapter.writeStream({
      ...options,
      ...(this.dataPlaneMode === undefined ? {} : { dataPlaneMode: this.dataPlaneMode }),
      expectedBytes: bytes.byteLength,
      mode: "atomic",
      path,
      sandboxId: this.sandboxId,
      source: bytes,
    });
  }

  private notifyStreamingFallbackOnce(operation: string, filepath: string, size: number): void {
    if (this.streamingFallbackNotified) {
      console.debug(`Streaming fallback for ${operation} on ${filepath} (${size} bytes)`);
      return;
    }

    console.info(
      `${operation} for '${filepath}' (${size} bytes) used StreamExec fallback ` +
        `(unary file size limit).`,
    );
    this.streamingFallbackNotified = true;
  }
}

function validatedChunkSource(source: FileChunkSource): FileChunkSource {
  if (source instanceof Uint8Array) {
    return source;
  }

  if (isAsyncIterable(source)) {
    return (async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of source) {
        yield requireUint8ArrayChunk(chunk);
      }
    })();
  }

  return (function* (): Generator<Uint8Array> {
    for (const chunk of source) {
      yield requireUint8ArrayChunk(chunk);
    }
  })();
}

function requireUint8ArrayChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  throw new CWSandboxValidationError("writeStream chunk must be a Uint8Array.");
}

function isAsyncIterable(value: object): value is AsyncIterable<Uint8Array> {
  return Symbol.asyncIterator in value;
}
