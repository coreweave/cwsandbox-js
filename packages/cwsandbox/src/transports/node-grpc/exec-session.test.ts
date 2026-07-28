// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxTransportError } from "../../errors.js";
import { STREAM_BACKPRESSURE } from "../../internal/error-info.js";
import { startExecSession, type ExecFrame } from "./exec-session.js";
import type { GatewayStreamingServiceClient } from "./generated/coreweave/sandbox/v1beta2/streaming.client.js";
import type {
  ExecStreamRequest,
  ExecStreamResponse,
} from "./generated/coreweave/sandbox/v1beta2/streaming.js";

describe("startExecSession", () => {
  it("settles ready and exit frames cleanly", async () => {
    const duplex = createMockDuplex();
    const session = await startExecSession(duplex.client, {
      command: ["echo", "hi"],
      sandboxId: "sbx",
    });

    duplex.push({
      response: {
        oneofKind: "ready",
        ready: { sessionId: "sess-1" },
      },
    });
    duplex.push({
      response: {
        exit: { exitCode: 0 },
        oneofKind: "exit",
      },
    });
    duplex.end();

    await expect(collectFrames(session.frames)).resolves.toEqual([
      { sessionId: "sess-1", type: "ready" },
      { exitCode: 0, type: "exit" },
    ]);
    expect(requestKinds(duplex.sent)).toEqual(["init"]);
  });

  it("maps an error frame and ends the session", async () => {
    const duplex = createMockDuplex();
    const session = await startExecSession(duplex.client, {
      command: ["echo", "hi"],
      sandboxId: "sbx",
    });

    duplex.push({
      response: {
        error: { code: STREAM_BACKPRESSURE, message: "slow" },
        oneofKind: "error",
      },
    });
    duplex.end();

    const frames = await collectFrames(session.frames);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      error: { streamCode: STREAM_BACKPRESSURE },
      type: "error",
    });
  });

  it("cancel aborts outstanding frame collection", async () => {
    const duplex = createMockDuplex();
    const session = await startExecSession(duplex.client, {
      command: ["sleep", "10"],
      sandboxId: "sbx",
    });

    const pending = collectFrames(session.frames);
    session.cancel(new Error("stop-now"));

    const frames = await pending;
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe("error");
    expect(duplex.aborted).toBe(true);
  });

  it("emits an error when the stream ends without an exit status", async () => {
    const duplex = createMockDuplex();
    const session = await startExecSession(duplex.client, {
      command: ["echo", "hi"],
      sandboxId: "sbx",
    });

    duplex.push({
      response: {
        oneofKind: "ready",
        ready: { sessionId: "sess-1" },
      },
    });
    duplex.end();

    const frames = await collectFrames(session.frames);
    expect(frames).toEqual([
      { sessionId: "sess-1", type: "ready" },
      {
        error: expect.any(CWSandboxTransportError),
        type: "error",
      },
    ]);
    expect(String(frames[1] && "error" in frames[1] ? frames[1].error : "")).toMatch(
      /ended without an exit status/i,
    );
  });
});

async function collectFrames(frames: AsyncIterable<ExecFrame>): Promise<ExecFrame[]> {
  const collected: ExecFrame[] = [];
  for await (const frame of frames) {
    collected.push(frame);
  }
  return collected;
}

function requestKinds(sent: readonly ExecStreamRequest[]): string[] {
  return sent.map((message) => message.request.oneofKind ?? "undefined");
}

function createMockDuplex(): {
  readonly aborted: boolean;
  readonly client: GatewayStreamingServiceClient;
  readonly sent: ExecStreamRequest[];
  end(): void;
  push(response: ExecStreamResponse): void;
} {
  const sent: ExecStreamRequest[] = [];
  const pending: ExecStreamResponse[] = [];
  const waiters: Array<(value: IteratorResult<ExecStreamResponse>) => void> = [];
  const rejecters: Array<(reason: unknown) => void> = [];
  let closed = false;
  let aborted = false;
  let abortError: unknown;

  const failWaiters = (reason: unknown): void => {
    aborted = true;
    abortError = reason;
    while (rejecters.length > 0) {
      rejecters.shift()?.(reason);
    }
    waiters.length = 0;
  };

  const push = (response: ExecStreamResponse): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      rejecters.shift();
      waiter({ done: false, value: response });
      return;
    }
    pending.push(response);
  };

  const end = (): void => {
    closed = true;
    while (waiters.length > 0) {
      rejecters.shift();
      waiters.shift()?.({ done: true, value: undefined });
    }
  };

  const responses: AsyncIterable<ExecStreamResponse> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ExecStreamResponse>> {
          if (abortError !== undefined) {
            return Promise.reject(abortError);
          }
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
          return new Promise((resolve, reject) => {
            waiters.push(resolve);
            rejecters.push(reject);
          });
        },
      };
    },
  };

  const client = {
    streamExec(options?: { abort?: AbortSignal }) {
      options?.abort?.addEventListener(
        "abort",
        () => {
          failWaiters(options.abort?.reason ?? new Error("aborted"));
        },
        { once: true },
      );
      if (options?.abort?.aborted) {
        failWaiters(options.abort.reason ?? new Error("aborted"));
      }
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

  return {
    get aborted() {
      return aborted;
    },
    client,
    end,
    push,
    sent,
  };
}
