// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxResourceExhaustedError, CWSandboxTransportError } from "../errors.js";
import {
  CWSANDBOX_ERROR_DOMAIN,
  CWSANDBOX_FILE_TOO_LARGE,
  CWSANDBOX_RUNNER_OVERLOADED,
} from "./error-info.js";
import { shouldFallbackRead, shouldFallbackWrite } from "./file-fallback-signals.js";
import { MAX_AUTO_FALLBACK_BYTES } from "./file-limits.js";

describe("file fallback signals", () => {
  it("falls back reads on RESOURCE_EXHAUSTED decompress cliff", () => {
    const error = new CWSandboxResourceExhaustedError(
      "Read file failed: Received message that decompresses to a size larger than 4194304",
      { operation: "Read file" },
    );

    expect(shouldFallbackRead(error)).toEqual({ fallback: true });
  });

  it("falls back reads when code is resource_exhausted without instanceof match", () => {
    const error = new CWSandboxTransportError("exhausted", {
      operation: "Read file",
    });
    // Simulate a cross-realm / duplicate-module ResourceExhausted via code only.
    Object.defineProperty(error, "code", { value: "resource_exhausted" });

    expect(shouldFallbackRead(error)).toEqual({ fallback: true });
  });

  it("does not fall back reads on a trusted runner-overloaded rejection", () => {
    const error = new CWSandboxResourceExhaustedError("Read file failed: overloaded", {
      domain: CWSANDBOX_ERROR_DOMAIN,
      operation: "Read file",
      reason: CWSANDBOX_RUNNER_OVERLOADED,
      retryDelayMs: 1_000,
    });

    expect(shouldFallbackRead(error)).toEqual({ fallback: false });
    expect(shouldFallbackWrite(error, 1024)).toBe(false);
  });

  it("keeps the broad read fallback for an untrusted or bare RESOURCE_EXHAUSTED", () => {
    const untrusted = new CWSandboxResourceExhaustedError("Read file failed: overloaded", {
      domain: "example.com",
      operation: "Read file",
      reason: CWSANDBOX_RUNNER_OVERLOADED,
    });
    const bare = new CWSandboxResourceExhaustedError("Read file failed: exhausted", {
      operation: "Read file",
    });

    expect(shouldFallbackRead(untrusted)).toEqual({ fallback: true });
    expect(shouldFallbackRead(bare)).toEqual({ fallback: true });
  });

  it("falls back writes on grpc decompress / frame-size RESOURCE_EXHAUSTED", () => {
    const decompress = new CWSandboxResourceExhaustedError(
      "Write file failed: Received message that decompresses to a size larger than 4194304",
    );
    const frame = new CWSandboxResourceExhaustedError(
      "Write file failed: grpc: received message larger than max (10485760 vs. 4194304)",
    );

    expect(shouldFallbackWrite(decompress, 1024)).toBe(true);
    expect(shouldFallbackWrite(frame, 1024)).toBe(true);
  });

  it("does not fall back reads when FILE_TOO_LARGE size exceeds the ceiling", () => {
    const error = new CWSandboxTransportError("too large", {
      metadata: { size_bytes: String(MAX_AUTO_FALLBACK_BYTES + 1) },
      reason: CWSANDBOX_FILE_TOO_LARGE,
    });

    expect(shouldFallbackRead(error)).toEqual({ fallback: false });
  });
});
