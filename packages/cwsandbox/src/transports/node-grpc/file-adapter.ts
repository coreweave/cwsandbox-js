// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxFileError,
  CWSandboxStreamBackpressureError,
  CWSandboxStreamTruncatedError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxValidationError,
} from "../../errors.js";
import {
  CWSANDBOX_FILE_IO_FAILED,
  CWSANDBOX_FILE_IS_DIRECTORY,
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_TRUNCATED,
} from "../../internal/error-info.js";
import {
  STAT_INTEGRITY_TIMEOUT_MS,
  STREAMING_OUTPUT_QUEUE_SIZE,
  STREAMING_READ_STDERR_CAP_BYTES,
  STREAMING_WRITE_CHUNK_SIZE,
  TRUNCATION_CHECK_MIN_BYTES,
} from "../../internal/file-limits.js";
import { AsyncQueue } from "../../streaming/async-queue.js";
import type {
  FileAdapter,
  ReadFileRequest,
  ReadFileResult,
  ReadStreamRequest,
  WriteFileRequest,
  WriteStreamRequest,
} from "../../transport/file-adapter.js";
import type { GrpcClients } from "./channel.js";
import type { DirectDataPlane, DirectDataPlaneLease } from "./direct-data-plane.js";
import { startExecSession } from "./exec-session.js";
import type { SandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";
import {
  ReadFileRequest as ProtoReadFileRequest,
  SandboxDataPermission,
  WriteFileRequest as ProtoWriteFileRequest,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import { toRpcOptions, withGrpcErrorMapping } from "./rpc.js";

/**
 * Explicit `files.writeStream` script: direct `cat >` (no temp-and-rename).
 * A mid-stream cancel or transport error may leave a partial file.
 */
const WRITE_STREAM_DIRECT_SCRIPT = [
  "path=$1",
  'if ! cat > "$path"; then',
  '  printf "%s\\n" "Failed to write input stream to $path" >&2',
  "  exit 1",
  "fi",
].join("\n");

/**
 * Buffered-write fallback script: stage to a sibling temp file, verify size,
 * then `mv` onto the target so a mid-failure does not truncate an existing
 * destination.
 */
const WRITE_STREAM_ATOMIC_SCRIPT = [
  "path=$1",
  "expected=$2",
  'tmp="$path.tmp.$$"',
  "trap 'rm -f \"$tmp\"' EXIT",
  'if ! cat > "$tmp"; then',
  '  printf "%s\\n" "Failed to write input stream to temp for $path" >&2',
  '  rm -f "$tmp"',
  "  exit 1",
  "fi",
  'actual=$(wc -c < "$tmp") || { rm -f "$tmp"; exit 1; }',
  "set -- $actual",
  "actual=$1",
  'if [ "$actual" != "$expected" ]; then',
  '  printf "%s\\n" "Expected $expected bytes but wrote $actual bytes; temp write incomplete" >&2',
  '  rm -f "$tmp"',
  "  exit 1",
  "fi",
  'if ! mv -f "$tmp" "$path"; then',
  '  printf "%s\\n" "Failed to rename temp file onto $path" >&2',
  '  rm -f "$tmp"',
  "  exit 1",
  "fi",
  "trap - EXIT",
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

const STAT_SCRIPT = 'stat -c %s -- "$1" 2>/dev/null';

type UnaryFileClient = Pick<SandboxServiceClient, "readFile" | "writeFile">;
type StreamExecClient = Pick<SandboxServiceClient, "streamExec">;

export function createGrpcFileAdapter(
  clients: GrpcClients,
  directDataPlane?: DirectDataPlane,
): FileAdapter {
  return {
    read: (request) => selectedReadFile(clients.client, directDataPlane, request),
    write: (request) => selectedWriteFile(clients.client, directDataPlane, request),
    readStream: (request) => selectedReadStream(clients.client, directDataPlane, request),
    writeStream: (request) => selectedWriteStream(clients.client, directDataPlane, request),
  };
}

async function selectedWriteFile(
  gatewayClient: SandboxServiceClient,
  directDataPlane: DirectDataPlane | undefined,
  request: WriteFileRequest,
): Promise<void> {
  const lease = await acquireFileLease(directDataPlane, request, SandboxDataPermission.WRITE_FILE);
  try {
    await grpcWriteFile(lease?.client ?? gatewayClient, request);
  } finally {
    await lease?.release();
  }
}

async function selectedReadFile(
  gatewayClient: SandboxServiceClient,
  directDataPlane: DirectDataPlane | undefined,
  request: ReadFileRequest,
): Promise<ReadFileResult> {
  const lease = await acquireFileLease(directDataPlane, request, SandboxDataPermission.READ_FILE);
  try {
    return await grpcReadFile(lease?.client ?? gatewayClient, request);
  } finally {
    await lease?.release();
  }
}

function selectedReadStream(
  gatewayClient: SandboxServiceClient,
  directDataPlane: DirectDataPlane | undefined,
  request: ReadStreamRequest,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const lease = await acquireFileLease(
        directDataPlane,
        request,
        SandboxDataPermission.STREAM_EXEC,
      );
      try {
        yield* grpcReadStream(lease?.client ?? gatewayClient, request);
      } finally {
        await lease?.release();
      }
    },
  };
}

async function selectedWriteStream(
  gatewayClient: SandboxServiceClient,
  directDataPlane: DirectDataPlane | undefined,
  request: WriteStreamRequest,
): Promise<void> {
  const lease = await acquireFileLease(directDataPlane, request, SandboxDataPermission.STREAM_EXEC);
  try {
    await grpcWriteStream(lease?.client ?? gatewayClient, request);
  } finally {
    await lease?.release();
  }
}

function acquireFileLease(
  directDataPlane: DirectDataPlane | undefined,
  request: ReadFileRequest | ReadStreamRequest | WriteFileRequest | WriteStreamRequest,
  permission: SandboxDataPermission,
): Promise<DirectDataPlaneLease | undefined> {
  if (directDataPlane === undefined) {
    return Promise.resolve(undefined);
  }
  return directDataPlane.acquire({
    dataPlaneMode: request.dataPlaneMode ?? "auto",
    permission,
    sandboxId: request.sandboxId,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
}

async function grpcWriteFile(client: UnaryFileClient, request: WriteFileRequest): Promise<void> {
  await withGrpcErrorMapping(
    "Write file",
    () =>
      client.writeFile(
        ProtoWriteFileRequest.create({
          content: request.content,
          path: request.path,
          sandboxId: request.sandboxId,
        }),
        toRpcOptions(request),
      ).response,
    { filepath: request.path, sandboxId: request.sandboxId },
  );
}

async function grpcReadFile(
  client: UnaryFileClient,
  request: ReadFileRequest,
): Promise<ReadFileResult> {
  const response = await withGrpcErrorMapping(
    "Read file",
    () =>
      client.readFile(
        ProtoReadFileRequest.create({
          path: request.path,
          sandboxId: request.sandboxId,
        }),
        toRpcOptions(request),
      ).response,
    { filepath: request.path, sandboxId: request.sandboxId },
  );

  return { content: response.content };
}

function grpcReadStream(
  streamingClient: StreamExecClient,
  request: ReadStreamRequest,
): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return grpcReadStreamIterator(streamingClient, request);
    },
  };
}

async function* grpcReadStreamIterator(
  streamingClient: StreamExecClient,
  request: ReadStreamRequest,
): AsyncGenerator<Uint8Array, void, undefined> {
  const deadline = request.timeoutMs === undefined ? undefined : Date.now() + request.timeoutMs;
  request.signal?.throwIfAborted();
  throwIfReadTimedOut(deadline, request.sandboxId);

  let expectedSize = request.expectedSize;
  if (expectedSize === undefined) {
    const remaining = remainingMs(deadline);
    const statTimeoutMs =
      remaining === undefined
        ? STAT_INTEGRITY_TIMEOUT_MS
        : Math.min(STAT_INTEGRITY_TIMEOUT_MS, remaining);
    expectedSize = await statFileSize(streamingClient, request, statTimeoutMs);
    request.signal?.throwIfAborted();
    throwIfReadTimedOut(deadline, request.sandboxId);
  }

  const catTimeoutMs = remainingMs(deadline);
  if (catTimeoutMs === 0) {
    throw new CWSandboxTimeoutError("Read file timed out.", {
      operation: "Read file",
      sandboxId: request.sandboxId,
    });
  }

  const outputQueue = new AsyncQueue<Uint8Array>(STREAMING_OUTPUT_QUEUE_SIZE);

  let session;
  try {
    session = await startExecSession(streamingClient, {
      command: ["/bin/sh", "-c", READ_STREAM_SCRIPT, "cwsandbox-read-file-streaming", request.path],
      sandboxId: request.sandboxId,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(catTimeoutMs === undefined ? {} : { timeoutMs: catTimeoutMs }),
    });
  } catch (error) {
    throwReadStreamFailure(request.signal, error, request.sandboxId);
  }

  const onAbort = (): void => {
    session.cancel(request.signal?.reason);
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });

  let exitCode: number | undefined;
  const stderrChunks: Uint8Array[] = [];
  let stderrBytes = 0;
  let delivered = 0;

  // Collect frames in the background; push stdout to queue.
  const collect = (async () => {
    try {
      for await (const frame of session.frames) {
        switch (frame.type) {
          case "stdout":
            await outputQueue.push(frame.data.slice());
            delivered += frame.data.byteLength;
            break;
          case "stderr":
            stderrBytes = appendCappedStderr(stderrChunks, stderrBytes, frame.data);
            break;
          case "exit":
            exitCode = frame.exitCode;
            break;
          case "error":
            outputQueue.fail(remapReadFileTimeout(frame.error, request.sandboxId));
            return;
          case "ready":
            break;
        }
      }
      outputQueue.close();
    } catch (error) {
      outputQueue.fail(remapReadFileTimeout(error, request.sandboxId));
    }
  })();

  let settled = false;
  let failure: Error | undefined;
  try {
    request.signal?.throwIfAborted();
    for await (const chunk of outputQueue) {
      request.signal?.throwIfAborted();
      yield chunk;
    }

    await collect;
    settled = true;

    if (exitCode !== 0) {
      throw mapReadStreamExit(
        request.sandboxId,
        request.path,
        exitCode ?? -1,
        decodeStderr(stderrChunks),
      );
    }

    verifyNoTruncation(request.sandboxId, request.path, delivered, expectedSize);
  } catch (error) {
    request.signal?.throwIfAborted();
    const remapped = remapReadFileTimeout(error, request.sandboxId);
    failure = remapped;
    throw remapped;
  } finally {
    request.signal?.removeEventListener("abort", onAbort);
    if (!settled) {
      // Early abandon: close quietly so a blocked push unblocks. Real errors fail the queue.
      if (failure !== undefined) {
        outputQueue.fail(failure);
      } else {
        outputQueue.close();
      }
      session.cancel(failure);
      try {
        await collect;
      } catch {
        // Do not mask the consumer error (or quiet abandon) with cleanup failures.
      }
    }
  }
}

async function grpcWriteStream(
  streamingClient: StreamExecClient,
  request: WriteStreamRequest,
): Promise<void> {
  const script =
    request.mode === "atomic" ? WRITE_STREAM_ATOMIC_SCRIPT : WRITE_STREAM_DIRECT_SCRIPT;

  const args: [string, ...string[]] =
    request.mode === "atomic"
      ? [
          "/bin/sh",
          "-c",
          script,
          "cwsandbox-write-file",
          request.path,
          String(request.expectedBytes ?? 0),
        ]
      : ["/bin/sh", "-c", script, "cwsandbox-write-file-streaming", request.path];

  const session = await startExecSession(streamingClient, {
    command: args,
    sandboxId: request.sandboxId,
    stdin: true,
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  });

  const input = session.input;
  if (input === undefined) {
    throw new CWSandboxTransportError("Expected stdin on file write session.", {
      operation: "Write file",
      sandboxId: request.sandboxId,
      transport: "grpc",
    });
  }

  let exitCode: number | undefined;
  let stderr = "";

  const collect = (async () => {
    for await (const frame of session.frames) {
      switch (frame.type) {
        case "stderr":
          stderr += new TextDecoder().decode(frame.data);
          break;
        case "exit":
          exitCode = frame.exitCode;
          break;
        case "error":
          throw frame.error;
        case "ready":
        case "stdout":
          break;
      }
    }
  })();

  try {
    for await (const chunk of iterateFileChunks(request.source)) {
      request.signal?.throwIfAborted();
      await input.write(chunk.slice());
    }
    await input.close();

    await collect;

    if (exitCode !== 0) {
      const detail = stderr.trim() || `write command exited with status ${exitCode ?? -1}`;
      const message =
        request.mode === "atomic"
          ? `Failed to write file '${request.path}' via exec-stream fallback: ${detail}. The destination was not replaced (temp write / rename failed).`
          : `Failed to stream-write file '${request.path}': ${detail}. The target may be partial or truncated.`;
      throw new CWSandboxFileError(message, {
        filepath: request.path,
        operation: "Write file",
        reason: CWSANDBOX_FILE_IO_FAILED,
        sandboxId: request.sandboxId,
      });
    }
  } catch (error) {
    session.cancel(error);
    try {
      await collect;
    } catch {
      // Do not mask the original write failure with collector cleanup errors.
    }
    if (
      error instanceof CWSandboxFileError ||
      error instanceof CWSandboxStreamBackpressureError ||
      error instanceof CWSandboxStreamTruncatedError ||
      error instanceof CWSandboxValidationError
    ) {
      throw error;
    }
    if (isAbortError(error)) {
      throw error;
    }
    throw new CWSandboxFileError(
      `Failed to ${request.mode === "atomic" ? "write" : "stream-write"} file '${request.path}'. Upstream error: ${String(error)}`,
      {
        cause: error,
        filepath: request.path,
        operation: "Write file",
        reason: CWSANDBOX_FILE_IO_FAILED,
        sandboxId: request.sandboxId,
      },
    );
  }
}

async function statFileSize(
  streamingClient: StreamExecClient,
  request: ReadStreamRequest,
  timeoutMs: number,
): Promise<number | undefined> {
  try {
    const session = await startExecSession(streamingClient, {
      command: ["/bin/sh", "-c", STAT_SCRIPT, "cwsandbox-stat", request.path],
      sandboxId: request.sandboxId,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      timeoutMs,
    });

    let stdout = "";
    let exitCode: number | undefined;
    for await (const frame of session.frames) {
      if (frame.type === "error") {
        return undefined;
      }
      if (frame.type === "stdout") {
        stdout += new TextDecoder().decode(frame.data);
      } else if (frame.type === "exit") {
        exitCode = frame.exitCode;
      }
    }
    if (exitCode !== 0) {
      return undefined;
    }
    const value = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

async function* iterateFileChunks(
  source: WriteStreamRequest["source"],
): AsyncGenerator<Uint8Array> {
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

function remainingMs(deadline: number | undefined): number | undefined {
  if (deadline === undefined) {
    return undefined;
  }
  return Math.max(0, deadline - Date.now());
}

function throwIfReadTimedOut(deadline: number | undefined, sandboxId: string): void {
  const remaining = remainingMs(deadline);
  if (remaining !== undefined && remaining <= 0) {
    throw new CWSandboxTimeoutError("Read file timed out.", {
      operation: "Read file",
      sandboxId,
    });
  }
}

function remapReadFileTimeout(error: unknown, sandboxId: string): Error {
  if (error instanceof CWSandboxTimeoutError) {
    if (error.operation === "Read file") {
      return error;
    }
    return new CWSandboxTimeoutError(error.message, {
      cause: error,
      operation: "Read file",
      sandboxId,
    });
  }
  if (error instanceof Error) {
    return error;
  }
  return new CWSandboxTransportError("Read file failed.", {
    cause: error,
    operation: "Read file",
    sandboxId,
    transport: "grpc",
  });
}

function throwReadStreamFailure(
  signal: AbortSignal | undefined,
  error: unknown,
  sandboxId: string,
): never {
  signal?.throwIfAborted();
  throw remapReadFileTimeout(error, sandboxId);
}

function appendCappedStderr(chunks: Uint8Array[], usedBytes: number, data: Uint8Array): number {
  if (usedBytes >= STREAMING_READ_STDERR_CAP_BYTES) {
    return usedBytes;
  }
  const room = STREAMING_READ_STDERR_CAP_BYTES - usedBytes;
  const slice = data.byteLength <= room ? data : data.subarray(0, room);
  chunks.push(slice.slice());
  return usedBytes + slice.byteLength;
}

function decodeStderr(chunks: readonly Uint8Array[]): string {
  if (chunks.length === 0) {
    return "";
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

function mapReadStreamExit(
  sandboxId: string,
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
        sandboxId,
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
        sandboxId,
      },
    );
  }
  return new CWSandboxFileError(`Failed to stream-read file '${path}': ${detail}`, {
    filepath: path,
    operation: "Read file",
    reason: CWSANDBOX_FILE_IO_FAILED,
    sandboxId,
  });
}

function verifyNoTruncation(
  sandboxId: string,
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
      sandboxId,
    },
  );
}
