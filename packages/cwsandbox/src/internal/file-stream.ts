// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxFileError,
  CWSandboxStreamBackpressureError,
  CWSandboxStreamTruncatedError,
  CWSandboxValidationError,
} from "../errors.js";
import type { RequestOptions } from "../public/common.js";
import type { FileChunkSource } from "../public/files.js";
import { startCommand } from "../runtime/commands.js";
import type { SandboxRuntime } from "../runtime/context.js";
import {
  CWSANDBOX_FILE_IO_FAILED,
  CWSANDBOX_FILE_IS_DIRECTORY,
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_TRUNCATED,
} from "./error-info.js";
import { STREAMING_WRITE_CHUNK_SIZE, TRUNCATION_CHECK_MIN_BYTES } from "./file-limits.js";

export type { FileChunkSource };

/**
 * Python-shaped streaming write: direct `cat >` (no temp-and-rename). A mid-stream
 * cancel or transport error may leave a partial file.
 */
const WRITE_STREAM_SCRIPT = [
  "path=$1",
  'if ! cat > "$path"; then',
  '  printf "%s\\n" "Failed to write input stream to $path" >&2',
  "  exit 1",
  "fi",
].join("\n");

const READ_STREAM_SCRIPT = [
  "path=$1",
  'if [ ! -e "$path" ]; then',
  '  printf "%s\\n" "File not found: $path" >&2',
  "  exit 2",
  "fi",
  'if [ -d "$path" ]; then',
  '  printf "%s\\n" "Path is a directory: $path" >&2',
  "  exit 3",
  "fi",
  'cat < "$path"',
].join("\n");

export async function writeFileStream(
  runtime: SandboxRuntime,
  path: string,
  source: FileChunkSource,
  options: RequestOptions = {},
): Promise<void> {
  const process = await startCommand(
    runtime,
    ["/bin/sh", "-c", WRITE_STREAM_SCRIPT, "cwsandbox-write-file-streaming", path],
    {
      ...options,
      binaryOutput: true,
      bufferedMaxKiB: 64,
      check: false,
      stdin: true,
    },
  );

  try {
    for await (const chunk of iterateFileChunks(source)) {
      options.signal?.throwIfAborted();
      await process.stdin.write(chunk.slice(), options);
    }
    await process.stdin.close(options);

    const result = await process.wait(options);
    if (result.exitCode !== 0) {
      const detail =
        result.stderr.trim() || `stream-write command exited with status ${result.exitCode}`;
      throw new CWSandboxFileError(
        `Failed to stream-write file '${path}': ${detail}. ` +
          "The target may be partial or truncated.",
        {
          filepath: path,
          operation: "Write file",
          reason: CWSANDBOX_FILE_IO_FAILED,
          sandboxId: runtime.sandboxId,
        },
      );
    }
  } catch (error) {
    if (process.status === "running" || process.status === "starting") {
      await process.cancel().catch(() => undefined);
    }
    if (
      error instanceof CWSandboxFileError ||
      error instanceof CWSandboxStreamBackpressureError ||
      error instanceof CWSandboxStreamTruncatedError ||
      error instanceof CWSandboxValidationError ||
      isAbortError(error)
    ) {
      throw error;
    }

    throw new CWSandboxFileError(
      `Failed to stream-write file '${path}'. ` +
        `The target may be partial or truncated. Upstream error: ${String(error)}`,
      {
        cause: error,
        filepath: path,
        operation: "Write file",
        reason: CWSANDBOX_FILE_IO_FAILED,
        sandboxId: runtime.sandboxId,
      },
    );
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

export function readFileStream(
  runtime: SandboxRuntime,
  path: string,
  options: RequestOptions = {},
): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return readFileStreamIterator(runtime, path, options);
    },
  };
}

async function* readFileStreamIterator(
  runtime: SandboxRuntime,
  path: string,
  options: RequestOptions,
): AsyncGenerator<Uint8Array, void, undefined> {
  const expectedSize = await statFileSize(runtime, path, options);
  const process = await startCommand(
    runtime,
    ["/bin/sh", "-c", READ_STREAM_SCRIPT, "cwsandbox-read-file-streaming", path],
    {
      ...options,
      binaryOutput: true,
      bufferedMaxKiB: 64,
      check: false,
      streamStdoutOnly: true,
    },
  );

  const onAbort = (): void => {
    void process.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let delivered = 0;
  try {
    options.signal?.throwIfAborted();
    for await (const chunk of process.stdoutBinary) {
      options.signal?.throwIfAborted();
      delivered += chunk.byteLength;
      yield chunk;
    }

    const result = await process.wait(options);
    if (result.exitCode !== 0) {
      throw mapReadStreamExit(runtime, path, result.exitCode, result.stderr);
    }

    verifyNoTruncation(runtime, path, delivered, expectedSize);
  } catch (error) {
    if (
      error instanceof CWSandboxFileError ||
      error instanceof CWSandboxStreamBackpressureError ||
      error instanceof CWSandboxStreamTruncatedError ||
      error instanceof CWSandboxValidationError
    ) {
      throw error;
    }

    if (process.status === "running" || process.status === "starting") {
      await process.cancel().catch(() => undefined);
    }

    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (process.status === "running" || process.status === "starting") {
      await process.cancel().catch(() => undefined);
    }
  }
}

async function* iterateFileChunks(source: FileChunkSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    for (let offset = 0; offset < source.byteLength; offset += STREAMING_WRITE_CHUNK_SIZE) {
      const end = Math.min(offset + STREAMING_WRITE_CHUNK_SIZE, source.byteLength);
      yield source.subarray(offset, end);
    }
    return;
  }

  if (isAsyncIterable(source)) {
    for await (const chunk of source) {
      yield coerceChunk(chunk);
    }
    return;
  }

  for (const chunk of source) {
    yield coerceChunk(chunk);
  }
}

function coerceChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }

  throw new CWSandboxValidationError("writeStream chunk must be a Uint8Array.");
}

function isAsyncIterable(value: object): value is AsyncIterable<Uint8Array> {
  return Symbol.asyncIterator in value;
}

async function statFileSize(
  runtime: SandboxRuntime,
  path: string,
  options: RequestOptions,
): Promise<number | undefined> {
  try {
    const process = await startCommand(
      runtime,
      ["/bin/sh", "-c", 'stat -c %s -- "$1" 2>/dev/null', "cwsandbox-stat", path],
      {
        ...options,
        bufferedMaxKiB: 64,
        check: false,
      },
    );
    const result = await process.wait(options);
    if (result.exitCode !== 0) {
      return undefined;
    }
    const text = result.stdout.trim();
    const value = Number.parseInt(text, 10);
    if (!Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function mapReadStreamExit(
  runtime: SandboxRuntime,
  path: string,
  exitCode: number,
  stderr: string,
): CWSandboxFileError {
  const detail = stderr.trim() || `stream-read command exited with status ${exitCode}`;
  if (exitCode === 2) {
    return new CWSandboxFileError(
      `File operation failed (${CWSANDBOX_FILE_NOT_FOUND}): ${detail}`,
      {
        filepath: path,
        operation: "Read file",
        reason: CWSANDBOX_FILE_NOT_FOUND,
        sandboxId: runtime.sandboxId,
      },
    );
  }
  if (exitCode === 3) {
    return new CWSandboxFileError(
      `File operation failed (${CWSANDBOX_FILE_IS_DIRECTORY}): ${detail}`,
      {
        filepath: path,
        operation: "Read file",
        reason: CWSANDBOX_FILE_IS_DIRECTORY,
        sandboxId: runtime.sandboxId,
      },
    );
  }
  return new CWSandboxFileError(`Failed to stream-read file '${path}': ${detail}`, {
    filepath: path,
    operation: "Read file",
    reason: CWSANDBOX_FILE_IO_FAILED,
    sandboxId: runtime.sandboxId,
  });
}

function verifyNoTruncation(
  runtime: SandboxRuntime,
  path: string,
  delivered: number,
  expected: number | undefined,
): void {
  if (expected === undefined || expected === 0 || expected < TRUNCATION_CHECK_MIN_BYTES) {
    return;
  }
  if (delivered >= expected) {
    return;
  }

  throw new CWSandboxFileError(
    `readStream of '${path}' was truncated: got ${delivered} of ${expected} bytes. ` +
      "Use readStream and drain it promptly, or read the file in smaller parts.",
    {
      filepath: path,
      metadata: {
        bytes_delivered: String(delivered),
        filepath: path,
        operation: "read_file_streaming",
        size_bytes: String(expected),
      },
      operation: "Read file",
      reason: CWSANDBOX_FILE_TRUNCATED,
      sandboxId: runtime.sandboxId,
    },
  );
}
