// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";

import {
  CWSandboxAuthenticationError,
  CWSandboxNotFoundError,
  CWSandboxResourceExhaustedError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
  type CWSandboxTransportErrorOptions,
} from "../../errors.js";
import { CWSANDBOX_ERROR_DOMAIN } from "../../internal/error-info.js";
import { parseErrorInfoFromMetadata } from "./error-info.js";

export interface GrpcErrorContext {
  readonly operation: string;
  readonly sandboxId?: string;
}

export function mapGrpcError(error: unknown, context: GrpcErrorContext): CWSandboxTransportError {
  if (error instanceof RpcError) {
    const details = grpcErrorOptions(error, context);
    const message = `${context.operation} failed: ${error.message}`;

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
    transport: "grpc",
  });
}

function grpcErrorOptions(
  error: RpcError,
  context: GrpcErrorContext,
): CWSandboxTransportErrorOptions {
  const parsed = parseErrorInfoFromMetadata(error.meta);
  const trusted =
    parsed !== undefined && parsed.domain === CWSANDBOX_ERROR_DOMAIN && parsed.reason.length > 0;

  return {
    ...context,
    cause: grpcErrorCause(error),
    metadata:
      parsed === undefined
        ? error.meta
        : {
            ...error.meta,
            ...parsed.metadata,
          },
    ...(trusted ? { reason: parsed.reason } : {}),
    transport: "grpc",
    transportCode: error.code,
  };
}

function grpcErrorCause(error: RpcError): Error {
  const cause = new Error(error.message);
  cause.name = "RpcError";
  return cause;
}
