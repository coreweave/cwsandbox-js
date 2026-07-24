// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxConfigurationError,
  CWSandboxError,
  CWSandboxTerminalStateUnavailableError,
  CWSandboxTimeoutError,
  CWSandboxValidationError,
  isCWSandboxError,
} from "./errors.js";

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

  it("exposes terminal-state unavailable as a typed transport error", () => {
    const error = new CWSandboxTerminalStateUnavailableError("ambiguous", {
      operation: "Wait for sandbox",
      sandboxId: "sandbox-123",
    });

    expect(error).toBeInstanceOf(CWSandboxError);
    expect(error.code).toBe("terminal_state_unavailable");
    expect(error.sandboxId).toBe("sandbox-123");
  });
});
