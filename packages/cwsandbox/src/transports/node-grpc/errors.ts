// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";

import {
  CWSandboxAuthenticationError,
  type CWSandboxError,
  CWSandboxFileError,
  CWSandboxNotFoundError,
  CWSandboxNotImplementedError,
  CWSandboxResourceExhaustedError,
  CWSandboxSnapshotBucketMismatchError,
  CWSandboxSnapshotQuotaExceededError,
  CWSandboxSnapshotSizeExceededError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
  type CWSandboxTransportErrorOptions,
} from "../../errors.js";
import {
  CWSANDBOX_COMMAND_TIMEOUT,
  CWSANDBOX_ERROR_DOMAIN,
  CWSANDBOX_FSS_BUCKET_MISMATCH,
  CWSANDBOX_FSS_NOT_FOUND,
  CWSANDBOX_FSS_NOT_SUPPORTED,
  CWSANDBOX_FSS_QUOTA_EXCEEDED,
  CWSANDBOX_FSS_SIZE_EXCEEDED,
  CWSANDBOX_RUNNER_SHARD_RETIRING,
  CWSANDBOX_SANDBOX_NOT_FOUND,
  FILE_ERROR_REASONS,
  UNAVAILABLE_REASONS,
} from "../../internal/error-info.js";
import { parseStatusDetailsFromMetadata } from "./error-info.js";

export interface GrpcErrorContext {
  readonly filepath?: string;
  readonly operation: string;
  readonly sandboxId?: string;
}

export function mapGrpcError(error: unknown, context: GrpcErrorContext): CWSandboxError {
  if (error instanceof RpcError) {
    const details = grpcErrorOptions(error, context);
    const message = `${context.operation} failed: ${error.message}`;
    const trusted =
      details.domain === CWSANDBOX_ERROR_DOMAIN &&
      details.reason !== undefined &&
      details.reason.length > 0;

    if (trusted) {
      const reason = details.reason;
      if (FILE_ERROR_REASONS.has(reason)) {
        const filepath = context.filepath ?? details.metadata?.["filepath"];
        return new CWSandboxFileError(`File operation failed (${reason}): ${error.message}`, {
          ...details,
          ...(typeof filepath === "string" ? { filepath } : {}),
        });
      }
      if (reason === CWSANDBOX_SANDBOX_NOT_FOUND || reason === CWSANDBOX_FSS_NOT_FOUND) {
        return new CWSandboxNotFoundError(message, details);
      }
      if (reason === CWSANDBOX_FSS_NOT_SUPPORTED) {
        return new CWSandboxNotImplementedError(message, details);
      }
      if (reason === CWSANDBOX_FSS_SIZE_EXCEEDED) {
        return new CWSandboxSnapshotSizeExceededError(message, details);
      }
      if (reason === CWSANDBOX_FSS_QUOTA_EXCEEDED) {
        return new CWSandboxSnapshotQuotaExceededError(message, details);
      }
      if (reason === CWSANDBOX_FSS_BUCKET_MISMATCH) {
        return new CWSandboxSnapshotBucketMismatchError(message, details);
      }
      if (UNAVAILABLE_REASONS.has(reason)) {
        return new CWSandboxUnavailableError(message, details);
      }
      if (reason === CWSANDBOX_COMMAND_TIMEOUT) {
        return new CWSandboxTimeoutError(message, details);
      }
    }

    switch (error.code) {
      case "UNAUTHENTICATED":
      case "PERMISSION_DENIED":
        return new CWSandboxAuthenticationError(message, details);
      case "NOT_FOUND":
        return new CWSandboxNotFoundError(message, details);
      case "DEADLINE_EXCEEDED":
        return new CWSandboxTimeoutError(message, details);
      case "UNAVAILABLE":
        return new CWSandboxUnavailableError(message, details);
      case "RESOURCE_EXHAUSTED":
        return new CWSandboxResourceExhaustedError(message, details);
      default:
        return new CWSandboxTransportError(message, details);
    }
  }

  return new CWSandboxTransportError(`${context.operation} failed.`, {
    ...context,
    cause: error,
    metadata: {},
    transport: "grpc",
  });
}

export function isGrpcUnavailable(error: unknown): boolean {
  if (error instanceof RpcError) {
    return error.code === "UNAVAILABLE";
  }
  if (error instanceof CWSandboxTransportError && error.transportCode === "UNAVAILABLE") {
    return true;
  }
  return error instanceof Error && error.cause !== error && isGrpcUnavailable(error.cause);
}

export function isRunnerShardRetiringError(error: unknown): boolean {
  if (error instanceof RpcError) {
    const parsed = parseStatusDetailsFromMetadata(error.meta);
    return (
      parsed?.domain === CWSANDBOX_ERROR_DOMAIN && parsed.reason === CWSANDBOX_RUNNER_SHARD_RETIRING
    );
  }
  if (
    error instanceof CWSandboxTransportError &&
    error.domain === CWSANDBOX_ERROR_DOMAIN &&
    error.reason === CWSANDBOX_RUNNER_SHARD_RETIRING
  ) {
    return true;
  }
  return error instanceof Error && error.cause !== error && isRunnerShardRetiringError(error.cause);
}

function grpcErrorOptions(
  error: RpcError,
  context: GrpcErrorContext,
): CWSandboxTransportErrorOptions {
  const parsed = parseStatusDetailsFromMetadata(error.meta);

  const domain = parsed?.domain === undefined || parsed.domain === "" ? undefined : parsed.domain;

  return {
    ...context,
    cause: error,
    metadata: parsed?.metadata ?? {},
    ...(domain === undefined ? {} : { domain }),
    ...(parsed?.reason === undefined ? {} : { reason: parsed.reason }),
    ...(parsed?.retryDelayMs === undefined ? {} : { retryDelayMs: parsed.retryDelayMs }),
    transport: "grpc",
    transportCode: error.code,
  };
}
