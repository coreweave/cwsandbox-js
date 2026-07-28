// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxTransportError, CWSandboxValidationError } from "../../errors.js";
import { CWSANDBOX_FILE_IO_FAILED, CWSANDBOX_FILE_TRUNCATED } from "../../internal/error-info.js";
import {
  STREAMING_OUTPUT_QUEUE_SIZE,
  TRUNCATION_CHECK_MIN_BYTES,
} from "../../internal/file-limits.js";
import type { GrpcClients } from "./channel.js";
import { createGrpcFileAdapter } from "./file-adapter.js";
import type { GatewayStreamingServiceClient } from "./generated/coreweave/sandbox/v1beta2/streaming.client.js";
import {
  ExecStreamOutput_StreamType as ProtoExecStreamOutputStreamType,
  type ExecStreamRequest,
  type ExecStreamResponse,
} from "./generated/coreweave/sandbox/v1beta2/streaming.js";

describe("createGrpcFileAdapter StreamExec paths", () => {
  it("cancels and settles when the readStream consumer stops early", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);

    harness.onCall(0, (duplex) => {
      // stat
      duplex.push(stdoutFrame(String(TRUNCATION_CHECK_MIN_BYTES)));
      duplex.push(exitFrame(0));
      duplex.end();
    });
    harness.onCall(1, (duplex) => {
      duplex.push(readyFrame("read-1"));
      // Fill past the output queue capacity and leave the StreamExec open so the
      // producer would hang forever without cancel + queue close.
      for (let i = 0; i < STREAMING_OUTPUT_QUEUE_SIZE + 8; i += 1) {
        duplex.push(stdoutFrame(new Uint8Array([i % 256])));
      }
    });

    const iterator = adapter
      .readStream({
        path: "/tmp/big.bin",
        sandboxId: "sbx",
      })
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);

    // Early abandon must settle (cancel session + unblock queue) without hanging.
    await expect(
      settledWithin(iterator.return?.() ?? Promise.resolve(), 2_000),
    ).resolves.toBeUndefined();
    expect(harness.calls[1]?.aborted).toBe(true);
  });

  it("detects truncation when delivered bytes are below the stated size", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);

    harness.onCall(0, (duplex) => {
      duplex.push(stdoutFrame(String(TRUNCATION_CHECK_MIN_BYTES)));
      duplex.push(exitFrame(0));
      duplex.end();
    });
    harness.onCall(1, (duplex) => {
      duplex.push(readyFrame("read-1"));
      duplex.push(stdoutFrame(new Uint8Array([1, 2, 3])));
      duplex.push(exitFrame(0));
      duplex.end();
    });

    await expect(async () => {
      for await (const _chunk of adapter.readStream({
        path: "/tmp/big.bin",
        sandboxId: "sbx",
      })) {
        // drain
      }
    }).rejects.toMatchObject({
      name: "CWSandboxFileError",
      reason: CWSANDBOX_FILE_TRUNCATED,
    });
  });

  it("raises when the read stream ends without an exit status", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);

    harness.onCall(0, (duplex) => {
      duplex.push(stdoutFrame("10"));
      duplex.push(exitFrame(0));
      duplex.end();
    });
    harness.onCall(1, (duplex) => {
      duplex.push(readyFrame("read-1"));
      duplex.push(stdoutFrame(new Uint8Array([1])));
      duplex.end();
    });

    await expect(async () => {
      for await (const _chunk of adapter.readStream({
        path: "/tmp/short.bin",
        sandboxId: "sbx",
      })) {
        // drain
      }
    }).rejects.toBeInstanceOf(CWSandboxTransportError);
  });

  it("maps nonzero read exit codes to CWSandboxFileError", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);

    harness.onCall(0, (duplex) => {
      duplex.push(stdoutFrame("10"));
      duplex.push(exitFrame(0));
      duplex.end();
    });
    harness.onCall(1, (duplex) => {
      duplex.push(readyFrame("read-1"));
      duplex.push(stderrFrame("disk exploded"));
      duplex.push(exitFrame(1));
      duplex.end();
    });

    await expect(async () => {
      for await (const _chunk of adapter.readStream({
        path: "/tmp/fail.bin",
        sandboxId: "sbx",
      })) {
        // drain
      }
    }).rejects.toMatchObject({
      name: "CWSandboxFileError",
      reason: CWSANDBOX_FILE_IO_FAILED,
    });
  });

  it("selects direct vs atomic write scripts from mode", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);

    harness.onCall(0, (duplex) => {
      duplex.push(readyFrame("write-direct"));
      duplex.push(exitFrame(0));
      duplex.end();
    });
    await adapter.writeStream({
      mode: "direct",
      path: "/tmp/direct.bin",
      sandboxId: "sbx",
      source: [new Uint8Array([1])],
    });
    expect(initCommand(harness.calls[0]?.sent ?? [])).toEqual(
      expect.arrayContaining(["cwsandbox-write-file-streaming", "/tmp/direct.bin"]),
    );

    harness.onCall(1, (duplex) => {
      duplex.push(readyFrame("write-atomic"));
      duplex.push(exitFrame(0));
      duplex.end();
    });
    await adapter.writeStream({
      expectedBytes: 1,
      mode: "atomic",
      path: "/tmp/atomic.bin",
      sandboxId: "sbx",
      source: new Uint8Array([1]),
    });
    expect(initCommand(harness.calls[1]?.sent ?? [])).toEqual(
      expect.arrayContaining(["cwsandbox-write-file", "/tmp/atomic.bin", "1"]),
    );
  });

  it("does not remask invalid writeStream chunks as CWSandboxFileError", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);

    harness.onCall(0, (duplex) => {
      duplex.push(readyFrame("write-1"));
      duplex.push(exitFrame(0));
      duplex.end();
    });

    await expect(
      adapter.writeStream({
        mode: "direct",
        path: "/tmp/bad.bin",
        sandboxId: "sbx",
        source: [123 as unknown as Uint8Array],
      }),
    ).rejects.toBeInstanceOf(CWSandboxValidationError);
  });
});

function initCommand(sent: readonly ExecStreamRequest[]): string[] {
  const init = sent.find((message) => message.request.oneofKind === "init");
  if (init?.request.oneofKind !== "init") {
    return [];
  }
  return [...init.request.init.command];
}

function readyFrame(sessionId: string): ExecStreamResponse {
  return {
    response: {
      oneofKind: "ready",
      ready: { sessionId },
    },
  };
}

function exitFrame(exitCode: number): ExecStreamResponse {
  return {
    response: {
      exit: { exitCode },
      oneofKind: "exit",
    },
  };
}

function stdoutFrame(data: string | Uint8Array): ExecStreamResponse {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return {
    response: {
      oneofKind: "output",
      output: {
        data: bytes,
        streamType: ProtoExecStreamOutputStreamType.STDOUT,
      },
    },
  };
}

function stderrFrame(message: string): ExecStreamResponse {
  return {
    response: {
      oneofKind: "output",
      output: {
        data: new TextEncoder().encode(message),
        streamType: ProtoExecStreamOutputStreamType.STDERR,
      },
    },
  };
}

async function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(() => undefined),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

interface MockDuplex {
  readonly aborted: boolean;
  readonly drainPromise: Promise<void>;
  readonly sent: ExecStreamRequest[];
  end(): void;
  push(response: ExecStreamResponse): void;
}

function createStreamingHarness(): {
  readonly calls: MockDuplex[];
  readonly clients: GrpcClients;
  onCall(index: number, setup: (duplex: MockDuplex) => void): void;
} {
  const setups = new Map<number, (duplex: MockDuplex) => void>();
  const calls: MockDuplex[] = [];
  let nextIndex = 0;

  const streamingClient = {
    streamExec(options?: { abort?: AbortSignal }) {
      const duplex = createMockDuplex(options?.abort);
      const index = nextIndex;
      nextIndex += 1;
      calls.push(duplex);
      setups.get(index)?.(duplex);
      return duplex.call;
    },
  } as unknown as GatewayStreamingServiceClient;

  return {
    calls,
    clients: {
      client: {} as GrpcClients["client"],
      streamingClient,
    },
    onCall(index, setup) {
      setups.set(index, setup);
    },
  };
}

function createMockDuplex(abort?: AbortSignal): MockDuplex & {
  readonly call: {
    readonly requests: {
      complete(): Promise<void>;
      send(message: ExecStreamRequest): Promise<void>;
    };
    readonly responses: AsyncIterable<ExecStreamResponse>;
    readonly status: Promise<{ code: string; detail: string }>;
  };
} {
  const sent: ExecStreamRequest[] = [];
  const pending: ExecStreamResponse[] = [];
  const waiters: Array<(value: IteratorResult<ExecStreamResponse>) => void> = [];
  const rejecters: Array<(reason: unknown) => void> = [];
  let closed = false;
  let aborted = false;
  let abortError: unknown;
  let resolveDrain!: () => void;
  const drainPromise = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });

  const failWaiters = (reason: unknown): void => {
    aborted = true;
    abortError = reason;
    while (rejecters.length > 0) {
      rejecters.shift()?.(reason);
    }
    waiters.length = 0;
    resolveDrain();
  };

  abort?.addEventListener(
    "abort",
    () => {
      failWaiters(abort.reason ?? new Error("aborted"));
    },
    { once: true },
  );
  if (abort?.aborted) {
    failWaiters(abort.reason ?? new Error("aborted"));
  }

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
    resolveDrain();
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

  return {
    get aborted() {
      return aborted;
    },
    call: {
      requests: {
        complete: async () => undefined,
        send: async (message: ExecStreamRequest) => {
          sent.push(message);
        },
      },
      responses,
      status: Promise.resolve({ code: "OK", detail: "" }),
    },
    drainPromise,
    end,
    push,
    sent,
  };
}
