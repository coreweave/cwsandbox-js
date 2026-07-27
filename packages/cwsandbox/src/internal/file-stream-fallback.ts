// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxFileError,
  CWSandboxStreamBackpressureError,
  CWSandboxStreamTruncatedError,
} from "../errors.js";
import type { RequestOptions } from "../public/common.js";
import { startCommand } from "../runtime/commands.js";
import type { SandboxRuntime } from "../runtime/context.js";
import {
  CWSANDBOX_FILE_IO_FAILED,
  CWSANDBOX_FILE_IS_DIRECTORY,
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_TRUNCATED,
} from "./error-info.js";
import { MAX_AUTO_FALLBACK_BYTES, STREAMING_WRITE_CHUNK_SIZE } from "./file-limits.js";

/**
 * Buffered write fallback: stage to a sibling temp file, verify size, then
 * `mv` onto the target so a mid-failure does not truncate an existing destination.
 * Requires a shell and `cat`/`wc`/`mv` in the sandbox image (no preflight probe).
 */
const WRITE_SCRIPT = [
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
  '  printf "%s\\n" "Expected $expected bytes but wrote $actual bytes; ' +
    'temp write incomplete" >&2',
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

const READ_SCRIPT = [
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

export async function writeFileViaStreamExec(
  runtime: SandboxRuntime,
  path: string,
  content: Uint8Array,
  options: RequestOptions = {},
): Promise<void> {
  const process = await startCommand(
    runtime,
    ["/bin/sh", "-c", WRITE_SCRIPT, "cwsandbox-write-file", path, String(content.byteLength)],
    {
      ...options,
      binaryOutput: true,
      bufferedMaxKiB: 64,
      check: false,
      stdin: true,
    },
  );

  try {
    for (let offset = 0; offset < content.byteLength; offset += STREAMING_WRITE_CHUNK_SIZE) {
      const end = Math.min(offset + STREAMING_WRITE_CHUNK_SIZE, content.byteLength);
      // Copy so gRPC ownership of the frame cannot alias the caller's buffer.
      await process.stdin.write(content.slice(offset, end), options);
    }
    await process.stdin.close(options);

    const result = await process.wait(options);
    if (result.exitCode !== 0) {
      const detail =
        result.stderr.trim() || `fallback command exited with status ${result.exitCode}`;
      throw new CWSandboxFileError(
        `Failed to write file '${path}' via exec-stream fallback: ${detail}. ` +
          "The destination was not replaced (temp write / rename failed).",
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
      error instanceof CWSandboxStreamTruncatedError
    ) {
      throw error;
    }

    throw new CWSandboxFileError(
      `Failed to write file '${path}' via exec-stream fallback. ` +
        `The destination was not replaced. Upstream error: ${String(error)}`,
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

/**
 * Read via StreamExec (`/bin/sh` + `cat`).
 * Uses internal `binaryOutput` (buffered path): bytes land in `wait().stdoutBytes`
 * without decoding a full stdout string or enqueueing `stdoutBinary`.
 */
export async function readFileViaStreamExec(
  runtime: SandboxRuntime,
  path: string,
  options: RequestOptions = {},
  expectedSize?: number,
): Promise<Uint8Array> {
  const sizeBudget = expectedSize ?? MAX_AUTO_FALLBACK_BYTES;
  const process = await startCommand(
    runtime,
    ["/bin/sh", "-c", READ_SCRIPT, "cwsandbox-read-file", path],
    {
      ...options,
      binaryOutput: true,
      bufferedMaxKiB: Math.max(1, Math.ceil(sizeBudget / 1024)),
      check: false,
    },
  );

  const result = await process.wait(options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `fallback command exited with status ${result.exitCode}`;
    if (result.exitCode === 2) {
      throw new CWSandboxFileError(
        `File operation failed (${CWSANDBOX_FILE_NOT_FOUND}): ${detail}`,
        {
          filepath: path,
          operation: "Read file",
          reason: CWSANDBOX_FILE_NOT_FOUND,
          sandboxId: runtime.sandboxId,
        },
      );
    }
    if (result.exitCode === 3) {
      throw new CWSandboxFileError(
        `File operation failed (${CWSANDBOX_FILE_IS_DIRECTORY}): ${detail}`,
        {
          filepath: path,
          operation: "Read file",
          reason: CWSANDBOX_FILE_IS_DIRECTORY,
          sandboxId: runtime.sandboxId,
        },
      );
    }
    throw new CWSandboxFileError(
      `Failed to read file '${path}' via exec-stream fallback: ${detail}`,
      {
        filepath: path,
        operation: "Read file",
        reason: CWSANDBOX_FILE_IO_FAILED,
        sandboxId: runtime.sandboxId,
      },
    );
  }

  const delivered = result.stdoutBytes.byteLength;
  if (result.stdoutTruncated) {
    throw new CWSandboxFileError(
      `read_file of '${path}' was truncated: got ${delivered} bytes ` +
        `(client buffer limit). Read the file in smaller parts.`,
      {
        filepath: path,
        metadata: {
          bytes_delivered: String(delivered),
          filepath: path,
          operation: "read_file",
        },
        operation: "Read file",
        reason: CWSANDBOX_FILE_TRUNCATED,
        sandboxId: runtime.sandboxId,
      },
    );
  }
  if (expectedSize !== undefined && expectedSize > 0 && delivered < expectedSize) {
    throw new CWSandboxFileError(
      `read_file of '${path}' was truncated: got ${delivered} of ${expectedSize} bytes. ` +
        "Read the file in smaller parts.",
      {
        filepath: path,
        metadata: {
          bytes_delivered: String(delivered),
          filepath: path,
          operation: "read_file",
          size_bytes: String(expectedSize),
        },
        operation: "Read file",
        reason: CWSANDBOX_FILE_TRUNCATED,
        sandboxId: runtime.sandboxId,
      },
    );
  }

  return result.stdoutBytes;
}

export function notifyStreamingFallbackOnce(
  runtime: SandboxRuntime,
  operation: string,
  filepath: string,
  size: number,
): void {
  if (runtime.streamingFallbackNotified) {
    console.debug(`Streaming fallback for ${operation} on ${filepath} (${size} bytes)`);
    return;
  }

  console.info(
    `${operation} for '${filepath}' (${size} bytes) used StreamExec fallback ` +
      `(unary file size limit).`,
  );
  runtime.streamingFallbackNotified = true;
}
