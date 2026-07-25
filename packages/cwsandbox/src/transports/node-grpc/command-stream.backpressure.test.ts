// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxFileError,
  CWSandboxStreamBackpressureError,
  CWSandboxTransportError,
  STREAM_BACKPRESSURE,
} from "../../index.js";
import { mapExecStreamError } from "./command-stream.js";

describe("mapExecStreamError", () => {
  it("maps STREAM_BACKPRESSURE to CWSandboxStreamBackpressureError", () => {
    const error = mapExecStreamError(STREAM_BACKPRESSURE, "backend said slow", "sb-1");

    expect(error).toBeInstanceOf(CWSandboxStreamBackpressureError);
    expect(error).not.toBeInstanceOf(CWSandboxFileError);
    expect(error).not.toBeInstanceOf(CWSandboxTransportError);
    expect((error as CWSandboxStreamBackpressureError).streamCode).toBe(STREAM_BACKPRESSURE);
  });

  it("maps other stream codes to CWSandboxTransportError", () => {
    const error = mapExecStreamError("STREAM_OTHER", "other failure", "sb-1");

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect((error as CWSandboxTransportError).transportCode).toBe("STREAM_OTHER");
  });
});
