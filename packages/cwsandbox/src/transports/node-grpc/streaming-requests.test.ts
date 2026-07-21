// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import type { ExecStreamRequest } from "./generated/coreweave/sandbox/v1beta2/streaming.js";
import {
  sendStreamingClose,
  sendStreamingInit,
  sendStreamingResize,
  sendStreamingShellInit,
  sendStreamingStdin,
  toStreamingCloseRequest,
  toStreamingInitRequest,
  toStreamingResizeRequest,
  toStreamingShellInitRequest,
  toStreamingStdinRequest,
  type StreamingRequestWriter,
} from "./streaming-requests.js";

describe("streaming request helpers", () => {
  it("maps streaming init requests", () => {
    expect(
      toStreamingInitRequest({
        command: ["printf", "it's ok"],
        cwd: "/workspace",
        sandboxId: "sandbox-123",
      }),
    ).toEqual({
      request: {
        init: {
          command: ["/bin/sh", "-lc", "cd '/workspace' && exec 'printf' 'it'\\''s ok'"],
          env: {},
          resumeSessionId: "",
          sandboxId: "sandbox-123",
          tty: false,
          ttyHeight: 0,
          ttyWidth: 0,
        },
        oneofKind: "init",
      },
    });
  });

  it("maps TTY init and resize requests", () => {
    expect(
      toStreamingShellInitRequest({
        cols: 80,
        command: ["/bin/sh"],
        rows: 24,
        sandboxId: "sandbox-123",
      }),
    ).toEqual({
      request: {
        init: {
          command: ["/bin/sh"],
          env: {},
          resumeSessionId: "",
          sandboxId: "sandbox-123",
          tty: true,
          ttyHeight: 24,
          ttyWidth: 80,
        },
        oneofKind: "init",
      },
    });
    expect(toStreamingResizeRequest(120, 40)).toEqual({
      request: {
        oneofKind: "resize",
        resize: {
          height: 40,
          width: 120,
        },
      },
    });
  });

  it("maps stdin and close requests", () => {
    const data = new Uint8Array([1, 2, 3]);

    expect(toStreamingStdinRequest(data)).toEqual({
      request: {
        oneofKind: "stdin",
        stdin: { data },
      },
    });
    expect(toStreamingCloseRequest()).toEqual({
      request: {
        close: {},
        oneofKind: "close",
      },
    });
  });

  it("sends init, stdin, and close messages in order", async () => {
    const writer = createTrackingWriter();
    const data = new Uint8Array([1, 2, 3]);

    await sendStreamingInit(writer, {
      command: ["cat"],
      sandboxId: "sandbox-123",
    });
    await sendStreamingStdin(writer, data);
    await sendStreamingClose(writer);
    await writer.complete();

    expect(writer.messages.map((message) => message.request.oneofKind)).toEqual([
      "init",
      "stdin",
      "close",
    ]);
    expect(writer.completeCalls).toBe(1);
  });

  it("sends TTY init and resize messages", async () => {
    const writer = createTrackingWriter();

    await sendStreamingShellInit(writer, {
      command: ["/bin/sh"],
      sandboxId: "sandbox-123",
    });
    await sendStreamingResize(writer, 120, 40);

    expect(writer.messages.map((message) => message.request.oneofKind)).toEqual(["init", "resize"]);
  });
});

function createTrackingWriter(): StreamingRequestWriter & {
  readonly completeCalls: number;
  readonly messages: ExecStreamRequest[];
} {
  const messages: ExecStreamRequest[] = [];
  let completeCalls = 0;

  return {
    get completeCalls() {
      return completeCalls;
    },
    messages,
    async complete() {
      completeCalls += 1;
    },
    async send(message) {
      messages.push(message);
    },
  };
}
