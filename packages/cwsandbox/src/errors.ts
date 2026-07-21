// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { ProcessResult } from "./public/commands.js";

export type CWSandboxErrorCode =
  | "authentication_error"
  | "configuration_error"
  | "execution_error"
  | "not_found"
  | "not_implemented"
  | "resource_exhausted"
  | "timeout_error"
  | "transport_error"
  | "unavailable"
  | "validation_error";

export type CWSandboxTransportKind = "fetch" | "grpc" | "http";

export interface CWSandboxTransportErrorOptions extends ErrorOptions {
  readonly metadata?: Readonly<Record<string, string | string[]>>;
  readonly operation?: string;
  readonly sandboxId?: string;
  readonly transport?: CWSandboxTransportKind;
  readonly transportCode?: number | string;
}

export class CWSandboxError extends Error {
  public readonly code: CWSandboxErrorCode;

  public constructor(message: string, code: CWSandboxErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "CWSandboxError";
  }
}

export function isCWSandboxError(error: unknown): error is CWSandboxError {
  return error instanceof CWSandboxError;
}

export class CWSandboxConfigurationError extends CWSandboxError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "configuration_error", options);
    this.name = "CWSandboxConfigurationError";
  }
}

export class CWSandboxNotImplementedError extends CWSandboxError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "not_implemented", options);
    this.name = "CWSandboxNotImplementedError";
  }
}

export class CWSandboxExecutionError extends CWSandboxError {
  public readonly result: ProcessResult;

  public constructor(result: ProcessResult, options?: ErrorOptions) {
    super(
      `Command '${result.command.join(" ")}' exited with code ${result.exitCode}.`,
      "execution_error",
      options,
    );
    this.name = "CWSandboxExecutionError";
    this.result = result;
  }
}

export class CWSandboxTransportError extends CWSandboxError {
  public readonly metadata: Readonly<Record<string, string | string[]>> | undefined;
  public readonly operation: string | undefined;
  public readonly sandboxId: string | undefined;
  public readonly transport: CWSandboxTransportKind | undefined;
  public readonly transportCode: number | string | undefined;

  public constructor(
    message: string,
    options: CWSandboxTransportErrorOptions = {},
    code: CWSandboxErrorCode = "transport_error",
  ) {
    super(message, code, options);
    this.name = "CWSandboxTransportError";
    this.metadata = options.metadata;
    this.operation = options.operation;
    this.sandboxId = options.sandboxId;
    this.transport = options.transport;
    this.transportCode = options.transportCode;
  }
}

export class CWSandboxAuthenticationError extends CWSandboxTransportError {
  public constructor(message: string, options?: CWSandboxTransportErrorOptions) {
    super(message, options, "authentication_error");
    this.name = "CWSandboxAuthenticationError";
  }
}

export class CWSandboxNotFoundError extends CWSandboxTransportError {
  public constructor(message: string, options?: CWSandboxTransportErrorOptions) {
    super(message, options, "not_found");
    this.name = "CWSandboxNotFoundError";
  }
}

export class CWSandboxTimeoutError extends CWSandboxTransportError {
  public constructor(message: string, options?: CWSandboxTransportErrorOptions) {
    super(message, options, "timeout_error");
    this.name = "CWSandboxTimeoutError";
  }
}

export class CWSandboxUnavailableError extends CWSandboxTransportError {
  public constructor(message: string, options?: CWSandboxTransportErrorOptions) {
    super(message, options, "unavailable");
    this.name = "CWSandboxUnavailableError";
  }
}

export class CWSandboxResourceExhaustedError extends CWSandboxTransportError {
  public constructor(message: string, options?: CWSandboxTransportErrorOptions) {
    super(message, options, "resource_exhausted");
    this.name = "CWSandboxResourceExhaustedError";
  }
}

export class CWSandboxValidationError extends CWSandboxError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "validation_error", options);
    this.name = "CWSandboxValidationError";
  }
}
