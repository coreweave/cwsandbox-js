// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import type { LogStreamRequest } from "./generated/coreweave/sandbox/v1beta2/streaming.js";
import {
  sendLogStreamClose,
  sendLogStreamInit,
  toLogStreamCloseRequest,
  toLogStreamInitRequest,
  type LogStreamingRequestWriter,
} from "./log-streaming-requests.js";

describe("log streaming request helpers", () => {
  it("maps finite log stream init requests", () => {
    expect(
      toLogStreamInitRequest({
        mode: "lines",
        sandboxId: "sandbox-123",
        tailLines: 50,
        timestamps: true,
      }),
    ).toEqual({
      request: {
        init: {
          follow: false,
          resumeOffset: "0",
          resumeSessionId: "",
          sandboxId: "sandbox-123",
          tailLines: 50,
          timestamps: true,
        },
        oneofKind: "init",
      },
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
      }).request,
    ).toMatchObject({
      init: {
        follow: true,
        sinceTime: {
          nanos: 123_000_000,
          seconds: "1780136430",
        },
      },
      oneofKind: "init",
    });

    expect(
      toLogStreamInitRequest({
        follow: true,
        mode: "raw",
        resume: { offset: 123n, sessionId: "session-1" },
        sandboxId: "sandbox-123",
      }).request,
    ).toMatchObject({
      init: {
        resumeOffset: "123",
        resumeSessionId: "session-1",
      },
    });
  });

  it("maps close requests and sends messages", async () => {
    const writer = createTrackingWriter();

    expect(toLogStreamCloseRequest()).toEqual({
      request: {
        close: {},
        oneofKind: "close",
      },
    });

    await sendLogStreamInit(writer, {
      follow: true,
      mode: "lines",
      sandboxId: "sandbox-123",
    });
    await sendLogStreamClose(writer);

    expect(writer.messages.map((message) => message.request.oneofKind)).toEqual(["init", "close"]);
  });
});

function createTrackingWriter(): LogStreamingRequestWriter & {
  readonly messages: LogStreamRequest[];
} {
  const messages: LogStreamRequest[] = [];

  return {
    messages,
    async complete() {
      return undefined;
    },
    async send(message) {
      messages.push(message);
    },
  };
}
