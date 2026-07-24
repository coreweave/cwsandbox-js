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
import {
  CWSANDBOX_BACKEND_UNAVAILABLE,
  CWSANDBOX_ERROR_DOMAIN,
  CWSANDBOX_FILE_TOO_LARGE,
  CWSANDBOX_SANDBOX_NOT_FOUND,
} from "../../internal/error-info.js";
import { mapGrpcError } from "./errors.js";

const SANDBOX_NOT_FOUND_B64 =
  "CAISBHRlc3QaWAoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxIsChtDV1NBTkRCT1hfU0FOREJPWF9OT1RfRk9VTkQSDWN3c2FuZGJveC5jb20=";

const BACKEND_UNAVAILABLE_WITH_RETRY_B64 =
  "CAISBHRlc3QaWgoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxIuCh1DV1NBTkRCT1hfQkFDS0VORF9VTkFWQUlMQUJMRRINY3dzYW5kYm94LmNvbRowCih0eXBlLmdvb2dsZWFwaXMuY29tL2dvb2dsZS5ycGMuUmV0cnlJbmZvEgQKAggC";

const EVIL_DOMAIN_NOT_FOUND_B64 =
  "CAISBHRlc3QaWwoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxIvChtDV1NBTkRCT1hfU0FOREJPWF9OT1RfRk9VTkQSEGV2aWwuZXhhbXBsZS5jb20=";

const FILE_TOO_LARGE_B64 =
  "CAISBHRlc3QaaQoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxI9ChhDV1NBTkRCT1hfRklMRV9UT09fTEFSR0USDWN3c2FuZGJveC5jb20aEgoIZmlsZXBhdGgSBi90bXAveA==";

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
    const cause = new RpcError("gone", "INTERNAL", {
      "grpc-status-details-bin": SANDBOX_NOT_FOUND_B64,
    });

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
    const cause = new RpcError("down", "INTERNAL", {
      "grpc-status-details-bin": BACKEND_UNAVAILABLE_WITH_RETRY_B64,
    });

    const error = mapGrpcError(cause, { operation: "Get sandbox" });

    expect(error).toBeInstanceOf(CWSandboxUnavailableError);
    expect(error.reason).toBe(CWSANDBOX_BACKEND_UNAVAILABLE);
    expect(error.retryDelayMs).toBe(2000);
  });

  it("attaches file reasons without remapping the exception class", () => {
    const cause = new RpcError("too large", "INTERNAL", {
      "grpc-status-details-bin": FILE_TOO_LARGE_B64,
    });

    const error = mapGrpcError(cause, { operation: "Read file" });

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect(error).not.toBeInstanceOf(CWSandboxNotFoundError);
    expect(error.reason).toBe(CWSANDBOX_FILE_TOO_LARGE);
    expect(error.metadata).toEqual({ filepath: "/tmp/x" });
  });

  it("does not remap reasons under an untrusted domain", () => {
    const cause = new RpcError("spoof", "INTERNAL", {
      "grpc-status-details-bin": EVIL_DOMAIN_NOT_FOUND_B64,
    });

    const error = mapGrpcError(cause, { operation: "Stop sandbox" });

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect(error).not.toBeInstanceOf(CWSandboxNotFoundError);
    expect(error.reason).toBe(CWSANDBOX_SANDBOX_NOT_FOUND);
    expect(error.domain).toBe("evil.example.com");
  });
});
