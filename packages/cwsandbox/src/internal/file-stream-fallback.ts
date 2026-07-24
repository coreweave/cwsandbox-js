// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxNotFoundError, CWSandboxTransportError } from "../errors.js";
import type { RequestOptions } from "../public/common.js";
import { startCommand } from "../runtime/commands.js";
import type { SandboxRuntime } from "../runtime/context.js";
import { MAX_AUTO_FALLBACK_BYTES, STREAMING_WRITE_CHUNK_SIZE } from "./file-limits.js";

/**
 * Python-shaped write: one StreamExec with `cat >` + in-script `wc -c` verify.
 * Requires a shell and `cat`/`wc` in the sandbox image (no preflight probe).
 */
const WRITE_SCRIPT = [
  "path=$1",
  "expected=$2",
  'if ! cat > "$path"; then',
  '  printf "%s\\n" "Failed to write input stream to $path" >&2',
  "  exit 1",
  "fi",
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

export async function writeFileViaStreamExec(
  runtime: SandboxRuntime,
  path: string,
  content: Uint8Array,
  options: RequestOptions = {},
): Promise<void> {
  try {
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
      throw new CWSandboxTransportError(
        `Failed to write file '${path}' via exec-stream fallback: ${detail}. ` +
          "The target may be partial or truncated.",
        {
          operation: "Write file",
          sandboxId: runtime.sandboxId,
        },
      );
    }
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

/**
 * Read via StreamExec (`/bin/sh` + `cat`). Uses binaryOutput so wait() does not
 * decode/build a full stdout string for large payloads.
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

  const delivered = result.stdoutBytes.byteLength;
  if (result.stdoutTruncated) {
    throw new CWSandboxTransportError(
      `StreamExec read of '${path}' was truncated after ${delivered} bytes ` +
        `(client buffer limit). Retry with a higher memory budget or read in parts.`,
      {
        operation: "Read file",
        sandboxId: runtime.sandboxId,
      },
    );
  }
  if (expectedSize !== undefined && expectedSize > 0 && delivered < expectedSize) {
    throw new CWSandboxTransportError(
      `StreamExec read of '${path}' was short: got ${delivered} of ${expectedSize} bytes.`,
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
