// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxNotFoundError, CWSandboxTransportError } from "../errors.js";
import type { RequestOptions } from "../public/common.js";
import { startCommand } from "../runtime/commands.js";
import type { SandboxRuntime } from "../runtime/context.js";
import {
  MAX_AUTO_FALLBACK_BYTES,
  STREAMING_WRITE_CHUNK_SIZE,
  STREAMING_WRITE_SESSION_BYTES,
} from "./file-limits.js";

const WRITE_SESSION_SCRIPT = [
  "path=$1",
  "mode=$2",
  'if [ "$mode" = "truncate" ]; then',
  '  if ! cat > "$path"; then',
  '    printf "%s\\n" "Failed to write input stream to $path" >&2',
  "    exit 1",
  "  fi",
  "else",
  '  if ! cat >> "$path"; then',
  '    printf "%s\\n" "Failed to append input stream to $path" >&2',
  "    exit 1",
  "  fi",
  "fi",
].join("\n");

const VERIFY_WRITE_SCRIPT = [
  "path=$1",
  "expected=$2",
  'actual=$(wc -c < "$path") || exit 1',
  "set -- $actual",
  "actual=$1",
  'if [ "$actual" != "$expected" ]; then',
  '  printf "%s\\n" "Expected $expected bytes but wrote $actual bytes; ' +
    'target may be partial or truncated" >&2',
  "  exit 1",
  "fi",
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

/**
 * Write via StreamExec (`/bin/sh` + `cat`). Requires a shell and `cat`/`wc` in
 * the sandbox image; there is no preflight probe (Python parity).
 *
 * Large payloads are split across append sessions to avoid runner stdin OOMs.
 */
export async function writeFileViaStreamExec(
  runtime: SandboxRuntime,
  path: string,
  content: Uint8Array,
  options: RequestOptions = {},
): Promise<void> {
  try {
    if (content.byteLength === 0) {
      await writeStreamSession(runtime, path, content, "truncate", options);
    } else {
      for (let offset = 0; offset < content.byteLength; offset += STREAMING_WRITE_SESSION_BYTES) {
        const end = Math.min(offset + STREAMING_WRITE_SESSION_BYTES, content.byteLength);
        await writeStreamSession(
          runtime,
          path,
          content.subarray(offset, end),
          offset === 0 ? "truncate" : "append",
          options,
        );
      }
    }
    await verifyWrittenSize(runtime, path, content.byteLength, options);
  } catch (error) {
    if (error instanceof CWSandboxTransportError) {
      throw error;
    }

    throw new CWSandboxTransportError(
      `Failed to write file '${path}' via exec-stream fallback. ` +
        `The target may be partial or truncated. Upstream error: ${String(error)}`,
      {
        cause: error,
        operation: "Write file",
        sandboxId: runtime.sandboxId,
      },
    );
  }
}

async function writeStreamSession(
  runtime: SandboxRuntime,
  path: string,
  content: Uint8Array,
  mode: "append" | "truncate",
  options: RequestOptions,
): Promise<void> {
  const process = await startCommand(
    runtime,
    ["/bin/sh", "-c", WRITE_SESSION_SCRIPT, "cwsandbox-write-file", path, mode],
    {
      ...options,
      bufferedMaxKiB: 64,
      check: false,
      stdin: true,
    },
  );

  for (let offset = 0; offset < content.byteLength; offset += STREAMING_WRITE_CHUNK_SIZE) {
    const end = Math.min(offset + STREAMING_WRITE_CHUNK_SIZE, content.byteLength);
    // Copy so gRPC ownership of the frame cannot alias the caller's buffer.
    await process.stdin.write(content.slice(offset, end), options);
  }
  await process.stdin.close(options);

  const result = await process.wait(options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `fallback command exited with status ${result.exitCode}`;
    throw new CWSandboxTransportError(
      `Failed to write file '${path}' via exec-stream fallback: ${detail}. ` +
        "The target may be partial or truncated.",
      {
        operation: "Write file",
        sandboxId: runtime.sandboxId,
      },
    );
  }
}

async function verifyWrittenSize(
  runtime: SandboxRuntime,
  path: string,
  expectedBytes: number,
  options: RequestOptions,
): Promise<void> {
  const process = await startCommand(
    runtime,
    ["/bin/sh", "-c", VERIFY_WRITE_SCRIPT, "cwsandbox-verify-write", path, String(expectedBytes)],
    {
      ...options,
      bufferedMaxKiB: 64,
      check: false,
    },
  );

  const result = await process.wait(options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `fallback command exited with status ${result.exitCode}`;
    throw new CWSandboxTransportError(
      `Failed to write file '${path}' via exec-stream fallback: ${detail}. ` +
        "The target may be partial or truncated.",
      {
        operation: "Write file",
        sandboxId: runtime.sandboxId,
      },
    );
  }
}

/**
 * Read via StreamExec (`/bin/sh` + `cat`). Uses `wait().stdoutBytes` (binary-safe).
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
      bufferedMaxKiB: Math.max(1, Math.ceil(sizeBudget / 1024)),
      check: false,
    },
  );

  const result = await process.wait(options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `fallback command exited with status ${result.exitCode}`;
    if (result.exitCode === 2) {
      throw new CWSandboxNotFoundError(`File operation failed: ${detail}`, {
        operation: "Read file",
        sandboxId: runtime.sandboxId,
      });
    }
    throw new CWSandboxTransportError(
      result.exitCode === 3
        ? `File operation failed: ${detail}`
        : `Failed to read file '${path}' via exec-stream fallback: ${detail}`,
      {
        operation: "Read file",
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
  suggestMethod: string,
): void {
  if (runtime.streamingFallbackNotified) {
    console.debug(`Streaming fallback for ${operation} on ${filepath} (${size} bytes)`);
    return;
  }

  console.info(
    `${operation} for '${filepath}' (${size} bytes) is being streamed; ` +
      `prefer ${suggestMethod}() for large files.`,
  );
  runtime.streamingFallbackNotified = true;
}
