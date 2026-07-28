// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import type { GatewayStreamingServiceClient } from "./generated/coreweave/sandbox/v1beta2/streaming.client.js";
import type {
  ExecStreamRequest,
  ExecStreamResponse,
} from "./generated/coreweave/sandbox/v1beta2/streaming.js";
import { startGrpcShell } from "./terminal-stream.js";

describe("startGrpcShell stdin ready gate", () => {
  it("does not send stdin, close, or resize until StreamExec ready", async () => {
    const duplex = createMockDuplex();
    const session = await startGrpcShell(duplex.client, {
      cols: 80,
      command: ["/bin/sh"],
      rows: 24,
      sandboxId: "sandbox-tty",
    });

    expect(requestKinds(duplex.sent)).toEqual(["init"]);

    // write is queued on stdin's writeQueue; yield so it enters the ready gate
    // before resize/close register their waiters (stable send order below).
    const writePromise = session.stdin.write("echo hi\n");
    await yieldEventLoop();
    const resizePromise = session.resize(100, 40);
    const closePromise = session.stdin.close();
    await yieldEventLoop();
    expect(requestKinds(duplex.sent)).toEqual(["init"]);

    duplex.push({
      response: {
        oneofKind: "ready",
        ready: { sessionId: "sess-1" },
      },
    });

    await Promise.all([writePromise, resizePromise, closePromise]);
    expect(requestKinds(duplex.sent)).toEqual(["init", "stdin", "resize", "close"]);

    duplex.push({
      response: {
        exit: { exitCode: 0 },
        oneofKind: "exit",
      },
    });
    duplex.end();

    await expect(session.wait()).resolves.toEqual({
      command: ["/bin/sh"],
      exitCode: 0,
    });
  });
});

function requestKinds(sent: readonly ExecStreamRequest[]): string[] {
  return sent.map((message) => message.request.oneofKind ?? "undefined");
}

async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createMockDuplex(): {
  readonly client: GatewayStreamingServiceClient;
  readonly sent: ExecStreamRequest[];
  end(): void;
  push(response: ExecStreamResponse): void;
} {
  const sent: ExecStreamRequest[] = [];
  const pending: ExecStreamResponse[] = [];
  const waiters: Array<(value: IteratorResult<ExecStreamResponse>) => void> = [];
  let closed = false;

  const push = (response: ExecStreamResponse): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: response });
      return;
    }
    pending.push(response);
  };

  const end = (): void => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()?.({ done: true, value: undefined });
    }
  };

  const responses: AsyncIterable<ExecStreamResponse> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ExecStreamResponse>> {
          if (pending.length > 0) {
            const value = pending.shift();
            if (value === undefined) {
              return Promise.resolve({ done: true, value: undefined });
            }
            return Promise.resolve({ done: false, value });
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };

  const client = {
    streamExec() {
      return {
        requests: {
          complete: async () => undefined,
          send: async (message: ExecStreamRequest) => {
            sent.push(message);
          },
        },
        responses,
        status: Promise.resolve({ code: "OK", detail: "" }),
      };
    },
  } as unknown as GatewayStreamingServiceClient;

  return { client, end, push, sent };
}
