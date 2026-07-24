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
  | "terminal_state_unavailable"
  | "timeout_error"
  | "transport_error"
  | "unavailable"
  | "validation_error";

export type CWSandboxTransportKind = "fetch" | "grpc" | "http";

export interface CWSandboxTransportErrorOptions extends ErrorOptions {
  /**
   * AIP-193 `ErrorInfo.domain` when present on the transport failure.
   */
  readonly domain?: string;
  /**
   * Path involved in a file operation. Caller-supplied values win over
   * `metadata.filepath` when constructing `CWSandboxFileError`.
   */
  readonly filepath?: string;
  /**
   * AIP-193 `ErrorInfo.metadata` map. Always treated as a string map; omit or
   * pass `{}` when no ErrorInfo metadata was present.
   */
  readonly metadata?: Readonly<Record<string, string>>;
  readonly operation?: string;
  /**
   * AIP-193 `ErrorInfo.reason` when present (e.g. `CWSANDBOX_SANDBOX_NOT_FOUND`).
   */
  readonly reason?: string;
  /**
   * Suggested client retry delay from `google.rpc.RetryInfo`, in milliseconds.
   */
  readonly retryDelayMs?: number;
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
  public readonly domain: string | undefined;
  /**
   * AIP-193 `ErrorInfo.metadata` map. Always present; empty when the failure
   * carried no ErrorInfo metadata.
   */
  public readonly metadata: Readonly<Record<string, string>>;
  public readonly operation: string | undefined;
  public readonly reason: string | undefined;
  public readonly retryDelayMs: number | undefined;
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
    this.domain = options.domain;
    this.metadata = options.metadata ?? {};
    this.operation = options.operation;
    this.reason = options.reason;
    this.retryDelayMs = options.retryDelayMs;
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

/**
 * Stop (or observe-after-stop) succeeded from the client's point of view, but
 * the backend never reported a terminal sandbox status within the retry budget.
 */
export class CWSandboxTerminalStateUnavailableError extends CWSandboxTransportError {
  public constructor(message: string, options?: CWSandboxTransportErrorOptions) {
    super(message, options, "terminal_state_unavailable");
    this.name = "CWSandboxTerminalStateUnavailableError";
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

/**
 * File operation failure in the sandbox (Python `SandboxFileError` parity).
 * Prefer switching on `reason` for AIP-193 file reasons.
 */
export class CWSandboxFileError extends CWSandboxTransportError {
  public readonly filepath: string | undefined;

  public constructor(message: string, options: CWSandboxTransportErrorOptions = {}) {
    super(message, options, "transport_error");
    this.name = "CWSandboxFileError";
    const fromMetadata = options.metadata?.["filepath"];
    this.filepath =
      options.filepath ?? (typeof fromMetadata === "string" ? fromMetadata : undefined);
  }
}

export class CWSandboxValidationError extends CWSandboxError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "validation_error", options);
    this.name = "CWSandboxValidationError";
  }
}
