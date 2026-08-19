// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { toLogStreamInitRequest } from "./log-streaming-requests.js";

describe("log streaming request helpers", () => {
  it("maps finite log stream requests", () => {
    expect(
      toLogStreamInitRequest({
        mode: "lines",
        sandboxId: "sandbox-123",
        tailLines: 50,
        timestamps: true,
      }),
    ).toMatchObject({
      follow: false,
      sandboxId: "sandbox-123",
      tailLines: 50,
      timestamps: true,
    });
  });

  it("maps follow, sinceTime, and resume fields", () => {
    const sinceTime = new Date("2026-05-30T10:20:30.123Z");

    expect(
      toLogStreamInitRequest({
        follow: true,
        mode: "entries",
        sandboxId: "sandbox-123",
        sinceTime,
      }),
    ).toMatchObject({
      follow: true,
      sandboxId: "sandbox-123",
      sinceTime: {
        nanos: 123_000_000,
        seconds: "1780136430",
      },
    });

    expect(
      toLogStreamInitRequest({
        follow: true,
        mode: "raw",
        resume: { offset: 123n, sessionId: "session-1" },
        sandboxId: "sandbox-123",
      }),
    ).toMatchObject({
      follow: true,
      resumeLogOffset: "123",
      resumeLogSessionId: "session-1",
      sandboxId: "sandbox-123",
    });
  });
});
