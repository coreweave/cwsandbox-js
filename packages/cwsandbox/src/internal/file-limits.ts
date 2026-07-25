// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/** Match the backend's default gRPC message-size limit for unary RPCs. */
export const DEFAULT_GRPC_MAX_MESSAGE_LENGTH_BYTES = 100 * 1024 * 1024;

/**
 * Server-enforced per-file cap for unary file write/read RPCs. Used as the
 * proactive client check before any unary RPC fires.
 */
export const DEFAULT_FILE_OPERATION_CAP_BYTES = 32 * 1024 * 1024;

/**
 * Hard ceiling on the per-file unary cap (channel max − 1 MiB framing headroom).
 */
export const MAX_FILE_UNARY_BYTES = DEFAULT_GRPC_MAX_MESSAGE_LENGTH_BYTES - 1024 * 1024;

/**
 * Above this size, files.write / files.read refuse auto StreamExec fallback.
 * Prefer `files.writeStream` / `files.readStream` for larger transfers.
 */
export const MAX_AUTO_FALLBACK_BYTES = 256 * 1024 * 1024;

/**
 * Skip post-drain truncation checks below this size (Python
 * `TRUNCATION_CHECK_MIN_BYTES` parity: half the auto-fallback ceiling).
 */
export const TRUNCATION_CHECK_MIN_BYTES = MAX_AUTO_FALLBACK_BYTES / 2;

/**
 * Chunk size for StreamExec stdin frames during large-file fallback.
 * Matches Python `STDIN_CHUNK_SIZE` used by `_exec_streaming_binary_async`.
 */
export const STREAMING_WRITE_CHUNK_SIZE = 64 * 1024;

/** Cap stderr buffering on binary StreamExec file reads (Python parity). */
export const STREAMING_READ_STDERR_CAP_BYTES = 16 * 1024;

/**
 * Max frames buffered on `stdoutBinary` between gRPC dispatch and the consumer.
 * Matches Python `STREAMING_OUTPUT_QUEUE_SIZE` used by `read_file_streaming`.
 */
export const STREAMING_OUTPUT_QUEUE_SIZE = 4096;

/**
 * Effective unary payload cap applied before AddFile.
 * Uses a server-observed cap when present; otherwise the default. Always
 * clamped to `MAX_FILE_UNARY_BYTES` (Python `_file_op_cap` parity).
 */
export function fileOperationCapBytes(observedFileOpCapBytes?: number): number {
  if (observedFileOpCapBytes !== undefined && observedFileOpCapBytes > 0) {
    return Math.min(observedFileOpCapBytes, MAX_FILE_UNARY_BYTES);
  }
  return Math.min(DEFAULT_FILE_OPERATION_CAP_BYTES, MAX_FILE_UNARY_BYTES);
}

/**
 * Cache `max_size_bytes` from a `FILE_TOO_LARGE` error (Python
 * `_record_observed_cap`). Stores the raw server value; clamp at use.
 */
export function recordObservedFileOpCap(
  runtime: { observedFileOpCapBytes: number | undefined },
  error: { readonly metadata?: Readonly<Record<string, string>> },
): void {
  const raw = error.metadata?.["max_size_bytes"];
  if (raw === undefined || raw === "") {
    return;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }
  runtime.observedFileOpCapBytes = value;
}
