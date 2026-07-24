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
 * Explicit streaming APIs are a separate follow-up.
 */
export const MAX_AUTO_FALLBACK_BYTES = 256 * 1024 * 1024;

/**
 * Chunk size for StreamExec stdin frames during large-file fallback.
 * Matches Python `STDIN_CHUNK_SIZE` used by `_exec_streaming_binary_async`.
 */
export const STREAMING_WRITE_CHUNK_SIZE = 64 * 1024;

/** Cap stderr buffering on binary StreamExec file reads (Python parity). */
export const STREAMING_READ_STDERR_CAP_BYTES = 16 * 1024;

/** Effective unary payload cap applied before AddFile. */
export function fileOperationCapBytes(): number {
  return Math.min(DEFAULT_FILE_OPERATION_CAP_BYTES, MAX_FILE_UNARY_BYTES);
}
