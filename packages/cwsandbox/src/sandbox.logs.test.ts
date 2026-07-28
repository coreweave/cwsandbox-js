// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError, type LogStream } from "./index.js";
import { createClient, createFakeTransport, createLogStream } from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";

describe("Sandbox logs", () => {
  it("forwards log stream options to the transport", async () => {
    const streamRequests: Parameters<SandboxTransport["streamLogs"]>[0][] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async streamLogs(request) {
        streamRequests.push(request);
        return createLogStream(request.mode);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);
    const sinceTime = new Date("2026-05-30T10:20:30.000Z");

    await sandbox.logs.stream({
      follow: true,
      resume: { offset: "12", sessionId: "session-1" },
      timeoutMs: 1234,
    });
    await sandbox.logs.streamEntries({ sinceTime, tailLines: 10, timestamps: true });
    await sandbox.logs.streamRaw();

    expect(streamRequests).toEqual([
      {
        follow: true,
        mode: "lines",
        resume: { offset: "12", sessionId: "session-1" },
        sandboxId: "sandbox-for-echo",
        timeoutMs: 1234,
      },
      {
        mode: "entries",
        sandboxId: "sandbox-for-echo",
        sinceTime,
        tailLines: 10,
        timestamps: true,
      },
      {
        mode: "raw",
        sandboxId: "sandbox-for-echo",
      },
    ]);
  });

  it("reads finite logs into an array", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async streamLogs() {
        return logStreamFrom(["a\n", "b\n"]);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.logs.read({ tailLines: 2 })).resolves.toEqual(["a\n", "b\n"]);
  });

  it("throws typed validation errors for invalid log options", async () => {
    const sandbox = await createClient().run(["echo", "hello"]);

    await expect(sandbox.logs.stream({ tailLines: -1 })).rejects.toThrow(CWSandboxValidationError);
    await expect(sandbox.logs.stream({ sinceTime: "not-a-date" })).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(
      sandbox.logs.stream({ follow: true, resume: { offset: -1, sessionId: "session" } }),
    ).rejects.toThrow(CWSandboxValidationError);
    await expect(
      sandbox.logs.read({ follow: true } as unknown as { follow: false }),
    ).rejects.toThrow(CWSandboxValidationError);
  });
});

function logStreamFrom(lines: readonly string[]): LogStream {
  return {
    cancel: async () => undefined,
    close: async () => undefined,
    closed: true,
    offset: undefined,
    sessionId: undefined,
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        yield line;
      }
    },
  };
}
