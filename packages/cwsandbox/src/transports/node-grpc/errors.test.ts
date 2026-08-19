// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";
import { describe, expect, it } from "vitest";

import {
  CWSandboxAuthenticationError,
  CWSandboxFileError,
  CWSandboxNotFoundError,
  CWSandboxResourceExhaustedError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
} from "../../errors.js";
import {
  CWSANDBOX_BACKEND_UNAVAILABLE,
  CWSANDBOX_COMMAND_TIMEOUT,
  CWSANDBOX_ERROR_DOMAIN,
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_TOO_LARGE,
  CWSANDBOX_SANDBOX_NOT_FOUND,
} from "../../internal/error-info.js";
import { mapGrpcError } from "./errors.js";
import { statusDetailsMeta } from "./test/status-details.js";

describe("mapGrpcError", () => {
  it.each(["UNAUTHENTICATED", "PERMISSION_DENIED"])("maps %s to authentication errors", (code) => {
    const cause = new RpcError("auth failed", code, { requestId: "req-123" });

    const error = mapGrpcError(cause, {
      operation: "Start sandbox",
    });

    expect(error).toBeInstanceOf(CWSandboxAuthenticationError);
    expect(error.code).toBe("authentication_error");
    expect(error.transport).toBe("grpc");
    expect(error.transportCode).toBe(code);
    expect(error.operation).toBe("Start sandbox");
    expect(error.metadata).toEqual({});
    expect(error.cause).toBe(cause);
  });

  it("maps NOT_FOUND to not found errors with sandbox context", () => {
    const cause = new RpcError("not found", "NOT_FOUND");

    const error = mapGrpcError(cause, {
      operation: "Get sandbox",
      sandboxId: "sandbox-123",
    });

    expect(error).toBeInstanceOf(CWSandboxNotFoundError);
    expect(error.code).toBe("not_found");
    expect(error.sandboxId).toBe("sandbox-123");
    expect(error.transportCode).toBe("NOT_FOUND");
    expect(error.metadata).toEqual({});
  });

  it("maps DEADLINE_EXCEEDED to timeout errors", () => {
    const cause = new RpcError("deadline", "DEADLINE_EXCEEDED");

    const error = mapGrpcError(cause, {
      operation: "Exec command",
      sandboxId: "sandbox-123",
    });

    expect(error).toBeInstanceOf(CWSandboxTimeoutError);
    expect(error.code).toBe("timeout_error");
    expect(error.operation).toBe("Exec command");
    expect(error.sandboxId).toBe("sandbox-123");
  });

  it("maps UNAVAILABLE to unavailable errors", () => {
    const error = mapGrpcError(new RpcError("unavailable", "UNAVAILABLE"), {
      operation: "Start sandbox",
    });

    expect(error).toBeInstanceOf(CWSandboxUnavailableError);
    expect(error.code).toBe("unavailable");
  });

  it("maps RESOURCE_EXHAUSTED to resource exhausted errors", () => {
    const error = mapGrpcError(new RpcError("exhausted", "RESOURCE_EXHAUSTED"), {
      operation: "Start sandbox",
    });

    expect(error).toBeInstanceOf(CWSandboxResourceExhaustedError);
    expect(error.code).toBe("resource_exhausted");
  });

  it("maps unknown RPC codes to generic transport errors", () => {
    const error = mapGrpcError(new RpcError("unknown", "UNKNOWN"), {
      operation: "Stop sandbox",
      sandboxId: "sandbox-123",
    });

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect(error.code).toBe("transport_error");
    expect(error.transportCode).toBe("UNKNOWN");
  });

  it("maps unknown thrown values to generic transport errors with cause", () => {
    const cause = new Error("boom");

    const error = mapGrpcError(cause, {
      operation: "Start sandbox",
    });

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect(error.code).toBe("transport_error");
    expect(error.operation).toBe("Start sandbox");
    expect(error.transport).toBe("grpc");
    expect(error.cause).toBe(cause);
    expect(error.metadata).toEqual({});
  });

  it("maps trusted CWSANDBOX_SANDBOX_NOT_FOUND to not-found even for INTERNAL", () => {
    const cause = new RpcError(
      "gone",
      "INTERNAL",
      statusDetailsMeta({
        errorInfos: [{ reason: CWSANDBOX_SANDBOX_NOT_FOUND }],
      }),
    );

    const error = mapGrpcError(cause, {
      operation: "Stop sandbox",
      sandboxId: "sandbox-123",
    });

    expect(error).toBeInstanceOf(CWSandboxNotFoundError);
    expect(error.reason).toBe(CWSANDBOX_SANDBOX_NOT_FOUND);
    expect(error.domain).toBe(CWSANDBOX_ERROR_DOMAIN);
    expect(error.cause).toBe(cause);
  });

  it("maps trusted unavailable reasons to unavailable with retryDelayMs", () => {
    const cause = new RpcError(
      "down",
      "INTERNAL",
      statusDetailsMeta({
        errorInfos: [{ reason: CWSANDBOX_BACKEND_UNAVAILABLE }],
        retryInfos: [{ retrySeconds: 2 }],
      }),
    );

    const error = mapGrpcError(cause, { operation: "Get sandbox" });

    expect(error).toBeInstanceOf(CWSandboxUnavailableError);
    expect(error.reason).toBe(CWSANDBOX_BACKEND_UNAVAILABLE);
    expect(error.retryDelayMs).toBe(2000);
  });

  it("maps trusted file reasons to CWSandboxFileError", () => {
    const cause = new RpcError(
      "too large",
      "INTERNAL",
      statusDetailsMeta({
        errorInfos: [
          {
            reason: CWSANDBOX_FILE_TOO_LARGE,
            metadata: { filepath: "/tmp/x" },
          },
        ],
      }),
    );

    const error = mapGrpcError(cause, { operation: "Read file" });

    expect(error).toBeInstanceOf(CWSandboxFileError);
    expect(error).not.toBeInstanceOf(CWSandboxNotFoundError);
    expect(error.reason).toBe(CWSANDBOX_FILE_TOO_LARGE);
    expect(error.metadata).toEqual({ filepath: "/tmp/x" });
    expect((error as CWSandboxFileError).filepath).toBe("/tmp/x");
  });

  it("prefers caller filepath over ErrorInfo metadata for FileError", () => {
    const cause = new RpcError(
      "missing",
      "NOT_FOUND",
      statusDetailsMeta({
        errorInfos: [
          {
            reason: CWSANDBOX_FILE_NOT_FOUND,
            metadata: { filepath: "/server/path" },
          },
        ],
      }),
    );

    const error = mapGrpcError(cause, {
      filepath: "/caller/path",
      operation: "Read file",
    });

    expect(error).toBeInstanceOf(CWSandboxFileError);
    expect(error.reason).toBe(CWSANDBOX_FILE_NOT_FOUND);
    expect((error as CWSandboxFileError).filepath).toBe("/caller/path");
  });

  it("does not remap reasons under an untrusted domain", () => {
    const cause = new RpcError(
      "spoof",
      "INTERNAL",
      statusDetailsMeta({
        errorInfos: [
          {
            domain: "evil.example.com",
            reason: CWSANDBOX_SANDBOX_NOT_FOUND,
          },
        ],
      }),
    );

    const error = mapGrpcError(cause, { operation: "Stop sandbox" });

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect(error).not.toBeInstanceOf(CWSandboxNotFoundError);
    expect(error.reason).toBe(CWSANDBOX_SANDBOX_NOT_FOUND);
    expect(error.domain).toBe("evil.example.com");
  });

  it("maps trusted CWSANDBOX_COMMAND_TIMEOUT to timeout errors", () => {
    const cause = new RpcError(
      "command timed out",
      "INTERNAL",
      statusDetailsMeta({
        errorInfos: [{ reason: CWSANDBOX_COMMAND_TIMEOUT }],
      }),
    );

    const error = mapGrpcError(cause, {
      operation: "Exec command",
      sandboxId: "sandbox-123",
    });

    expect(error).toBeInstanceOf(CWSandboxTimeoutError);
    expect(error.reason).toBe(CWSANDBOX_COMMAND_TIMEOUT);
    expect(error.domain).toBe(CWSANDBOX_ERROR_DOMAIN);
  });

  it("does not remap CWSANDBOX_COMMAND_TIMEOUT under an untrusted domain", () => {
    const cause = new RpcError(
      "spoof",
      "INTERNAL",
      statusDetailsMeta({
        errorInfos: [
          {
            domain: "evil.example.com",
            reason: CWSANDBOX_COMMAND_TIMEOUT,
          },
        ],
      }),
    );

    const error = mapGrpcError(cause, { operation: "Exec command" });

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect(error).not.toBeInstanceOf(CWSandboxTimeoutError);
    expect(error.reason).toBe(CWSANDBOX_COMMAND_TIMEOUT);
    expect(error.domain).toBe("evil.example.com");
  });
});
