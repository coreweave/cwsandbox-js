// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxExecutionError,
  CWSandboxFileError,
  CWSandboxStreamBackpressureError,
  CWSandboxStreamTruncatedError,
  CWSandboxTransportError,
  STREAM_BACKPRESSURE,
  STREAM_TRUNCATED,
} from "../../index.js";
import { mapExecStreamError } from "./command-stream.js";

describe("mapExecStreamError", () => {
  it("maps STREAM_BACKPRESSURE to CWSandboxStreamBackpressureError", () => {
    const error = mapExecStreamError(STREAM_BACKPRESSURE, "backend said slow", "sb-1");

    expect(error).toBeInstanceOf(CWSandboxStreamBackpressureError);
    expect(error).toBeInstanceOf(CWSandboxExecutionError);
    expect(error).not.toBeInstanceOf(CWSandboxFileError);
    expect(error).not.toBeInstanceOf(CWSandboxTransportError);
    expect((error as CWSandboxStreamBackpressureError).streamCode).toBe(STREAM_BACKPRESSURE);
  });

  it("maps STREAM_TRUNCATED to CWSandboxStreamTruncatedError", () => {
    const error = mapExecStreamError(STREAM_TRUNCATED, "lost output", "sb-1");

    expect(error).toBeInstanceOf(CWSandboxStreamTruncatedError);
    expect(error).toBeInstanceOf(CWSandboxExecutionError);
    expect(error).not.toBeInstanceOf(CWSandboxFileError);
    expect(error).not.toBeInstanceOf(CWSandboxTransportError);
    expect((error as CWSandboxStreamTruncatedError).streamCode).toBe(STREAM_TRUNCATED);
  });

  it("maps other stream codes to CWSandboxTransportError", () => {
    const error = mapExecStreamError("STREAM_OTHER", "other failure", "sb-1");

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect((error as CWSandboxTransportError).transportCode).toBe("STREAM_OTHER");
  });
});
