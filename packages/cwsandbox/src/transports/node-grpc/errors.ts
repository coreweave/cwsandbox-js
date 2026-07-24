// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";

import {
  CWSandboxAuthenticationError,
  CWSandboxFileError,
  CWSandboxNotFoundError,
  CWSandboxResourceExhaustedError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
  type CWSandboxTransportErrorOptions,
} from "../../errors.js";
import {
  CWSANDBOX_ERROR_DOMAIN,
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

export function mapGrpcError(error: unknown, context: GrpcErrorContext): CWSandboxTransportError {
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
        const filepath = context.filepath ?? details.metadata.filepath;
        return new CWSandboxFileError(`File operation failed (${reason}): ${error.message}`, {
          ...details,
          ...(typeof filepath === "string" ? { filepath } : {}),
        });
      }
      if (reason === CWSANDBOX_SANDBOX_NOT_FOUND) {
        return new CWSandboxNotFoundError(message, details);
      }
      if (UNAVAILABLE_REASONS.has(reason)) {
        return new CWSandboxUnavailableError(message, details);
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
