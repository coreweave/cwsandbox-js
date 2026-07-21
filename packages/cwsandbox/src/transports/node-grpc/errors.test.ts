// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";
import { describe, expect, it } from "vitest";

import {
  CWSandboxAuthenticationError,
  CWSandboxNotFoundError,
  CWSandboxResourceExhaustedError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
} from "../../errors.js";
import { mapGrpcError } from "./errors.js";

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
    expect(error.metadata).toEqual({ requestId: "req-123" });
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).not.toBe(cause);
    expect((error.cause as Error).name).toBe("RpcError");
    expect((error.cause as Error).message).toBe("auth failed");
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
  });

  it("attaches trusted ErrorInfo reason and metadata from status details", () => {
    const detailsBin =
      "CAkSOGZpbGUgcGF5bG9hZCBleGNlZWRzIGNvbmZpZ3VyZWQgbWF4LWZpbGUtb3BlcmF0aW9uLWJ5dGVzGrkBCih0eXBlLmdvb2dsZWFwaXMuY29tL2dvb2dsZS5ycGMuRXJyb3JJbmZvEowBChhDV1NBTkRCT1hfRklMRV9UT09fTEFSR0USDWN3c2FuZGJveC5jb20aEgoIZmlsZXBhdGgSBi90bXAveBoaCg5tYXhfc2l6ZV9ieXRlcxIIMzM1NTQ0MzIaFgoKc2l6ZV9ieXRlcxIINjcxMDg4NjQaGQoJb3BlcmF0aW9uEgxSZXRyaWV2ZUZpbGU=";
    const cause = new RpcError("file payload exceeds configured max-file-operation-bytes", "FAILED_PRECONDITION", {
      "grpc-status-details-bin": detailsBin,
    });

    const error = mapGrpcError(cause, {
      operation: "Read file",
      sandboxId: "sandbox-123",
    });

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect(error.reason).toBe("CWSANDBOX_FILE_TOO_LARGE");
    expect(error.metadata).toMatchObject({
      filepath: "/tmp/x",
      size_bytes: "67108864",
    });
  });
});
