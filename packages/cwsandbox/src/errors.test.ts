// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxConfigurationError,
  CWSandboxError,
  CWSandboxExecutionError,
  CWSandboxFileError,
  CWSandboxNotImplementedError,
  CWSandboxResourceExhaustedError,
  CWSandboxSnapshotBucketMismatchError,
  CWSandboxSnapshotQuotaExceededError,
  CWSandboxSnapshotSizeExceededError,
  CWSandboxStreamBackpressureError,
  CWSandboxStreamTruncatedError,
  CWSandboxTerminalStateUnavailableError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxValidationError,
  isCWSandboxError,
} from "./errors.js";
import { STREAM_BACKPRESSURE, STREAM_TRUNCATED } from "./internal/error-info.js";

describe("SDK error boundaries", () => {
  it("identifies SDK errors with a type guard", () => {
    const error = new CWSandboxValidationError("bad input");

    expect(isCWSandboxError(error)).toBe(true);
    expect(isCWSandboxError(new Error("boom"))).toBe(false);
    expect(isCWSandboxError("boom")).toBe(false);
  });

  it("preserves cause on local SDK errors", () => {
    const cause = new Error("invalid config source");
    const error = new CWSandboxConfigurationError("Invalid CWSandbox config.", { cause });

    expect(error).toBeInstanceOf(CWSandboxError);
    expect(error.code).toBe("configuration_error");
    expect(error.cause).toBe(cause);
  });

  it("keeps transport context on specialized transport errors", () => {
    const error = new CWSandboxTimeoutError("Timed out.", {
      operation: "Wait for sandbox",
      sandboxId: "sandbox-123",
      transport: "grpc",
      transportCode: "DEADLINE_EXCEEDED",
    });

    expect(error.code).toBe("timeout_error");
    expect(error.operation).toBe("Wait for sandbox");
    expect(error.sandboxId).toBe("sandbox-123");
    expect(error.transport).toBe("grpc");
    expect(error.transportCode).toBe("DEADLINE_EXCEEDED");
    expect(error.metadata).toEqual({});
  });

  it("exposes AIP-193 fields on transport errors", () => {
    const error = new CWSandboxTimeoutError("Timed out.", {
      domain: "cwsandbox.com",
      metadata: { filepath: "/tmp/x" },
      reason: "CWSANDBOX_COMMAND_TIMEOUT",
      retryDelayMs: 1500,
    });

    expect(error.reason).toBe("CWSANDBOX_COMMAND_TIMEOUT");
    expect(error.domain).toBe("cwsandbox.com");
    expect(error.metadata).toEqual({ filepath: "/tmp/x" });
    expect(error.retryDelayMs).toBe(1500);
  });

  it("copies AIP-193 fields onto not-implemented errors without becoming a transport error", () => {
    const cause = new Error("org disabled");
    const error = new CWSandboxNotImplementedError("FSS is not enabled.", {
      cause,
      domain: "cwsandbox.com",
      metadata: { org: "org-123" },
      reason: "CWSANDBOX_FSS_NOT_SUPPORTED",
    });

    expect(error).toBeInstanceOf(CWSandboxError);
    expect(error).not.toBeInstanceOf(CWSandboxTransportError);
    expect(error.code).toBe("not_implemented");
    expect(error.reason).toBe("CWSANDBOX_FSS_NOT_SUPPORTED");
    expect(error.domain).toBe("cwsandbox.com");
    expect(error.metadata).toEqual({ org: "org-123" });
    expect(error.cause).toBe(cause);
  });

  it("exposes terminal-state unavailable as a typed transport error", () => {
    const error = new CWSandboxTerminalStateUnavailableError("ambiguous", {
      operation: "Wait for sandbox",
      sandboxId: "sandbox-123",
    });

    expect(error).toBeInstanceOf(CWSandboxError);
    expect(error.code).toBe("terminal_state_unavailable");
    expect(error.sandboxId).toBe("sandbox-123");
  });

  it("exposes filepath on CWSandboxFileError from options or metadata", () => {
    const fromOption = new CWSandboxFileError("missing", {
      filepath: "/from/option",
      metadata: { filepath: "/from/meta" },
      reason: "CWSANDBOX_FILE_NOT_FOUND",
    });
    const fromMeta = new CWSandboxFileError("missing", {
      metadata: { filepath: "/from/meta" },
      reason: "CWSANDBOX_FILE_NOT_FOUND",
    });

    expect(fromOption).toBeInstanceOf(CWSandboxTransportError);
    expect(fromOption.filepath).toBe("/from/option");
    expect(fromMeta.filepath).toBe("/from/meta");
  });

  it.each([
    ["CWSANDBOX_FSS_SIZE_EXCEEDED", CWSandboxSnapshotSizeExceededError],
    ["CWSANDBOX_FSS_QUOTA_EXCEEDED", CWSandboxSnapshotQuotaExceededError],
    ["CWSANDBOX_FSS_BUCKET_MISMATCH", CWSandboxSnapshotBucketMismatchError],
  ] as const)("copies AIP-193 fields onto %s snapshot transport errors", (reason, ErrorClass) => {
    const cause = new Error("backend");
    const error = new ErrorClass("snapshot refused", {
      cause,
      domain: "cwsandbox.com",
      metadata: { org: "org-123" },
      reason,
    });

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect(error).not.toBeInstanceOf(CWSandboxResourceExhaustedError);
    expect(error.code).toBe("transport_error");
    expect(error.reason).toBe(reason);
    expect(error.domain).toBe("cwsandbox.com");
    expect(error.metadata).toEqual({ org: "org-123" });
    expect(error.cause).toBe(cause);
  });

  it("places stream backpressure in the execution-error family", () => {
    const error = new CWSandboxStreamBackpressureError("too slow", {
      streamCode: STREAM_BACKPRESSURE,
    });

    expect(error).toBeInstanceOf(CWSandboxStreamBackpressureError);
    expect(error).toBeInstanceOf(CWSandboxExecutionError);
    expect(error.code).toBe("execution_error");
    expect(error.result).toBeUndefined();
    expect(error.streamCode).toBe(STREAM_BACKPRESSURE);
  });

  it("places stream truncated in the execution-error family", () => {
    const error = new CWSandboxStreamTruncatedError("truncated", {
      streamCode: STREAM_TRUNCATED,
    });

    expect(error).toBeInstanceOf(CWSandboxStreamTruncatedError);
    expect(error).toBeInstanceOf(CWSandboxExecutionError);
    expect(error.code).toBe("execution_error");
    expect(error.result).toBeUndefined();
    expect(error.streamCode).toBe(STREAM_TRUNCATED);
  });
});
