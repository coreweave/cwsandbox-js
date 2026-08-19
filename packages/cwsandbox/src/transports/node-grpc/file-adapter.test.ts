// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError, type RpcOptions } from "@protobuf-ts/runtime-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CWSandboxTransportError, CWSandboxValidationError } from "../../errors.js";
import {
  CWSANDBOX_FILE_IO_FAILED,
  CWSANDBOX_FILE_IS_DIRECTORY,
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_TRUNCATED,
} from "../../internal/error-info.js";
import {
  STAT_INTEGRITY_TIMEOUT_MS,
  STREAMING_OUTPUT_QUEUE_SIZE,
  STREAMING_READ_STDERR_CAP_BYTES,
  TRUNCATION_CHECK_MIN_BYTES,
} from "../../internal/file-limits.js";
import type { GrpcClients } from "./channel.js";
import { createGrpcFileAdapter } from "./file-adapter.js";
import type { SandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";
import {
  ExecStreamOutput_Stream as ProtoExecStreamOutputStream,
  type ExecStreamRequest,
  type ExecStreamResponse,
} from "./generated/coreweave/sandbox/v1/sandbox.js";

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

describe("createGrpcFileAdapter readStream deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps stat at 10s and passes remaining time to cat", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, () => undefined);
    harness.onCall(1, completeCat);

    const pending = drainReadStream(
      adapter.readStream({ path: "/tmp/a.bin", sandboxId: "sbx", timeoutMs: 60_000 }),
    );
    const stat = await waitForCall(harness, 0);
    expect(stat.timeout).toBe(STAT_INTEGRITY_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(2_000);
    completeStat(stat);
    await pending;
    expect(harness.calls[1]?.timeout).toBe(58_000);
  });

  it("clamps stat to the caller budget when it is under 10s", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, () => undefined);
    harness.onCall(1, completeCat);

    const pending = drainReadStream(
      adapter.readStream({ path: "/tmp/a.bin", sandboxId: "sbx", timeoutMs: 5_000 }),
    );
    const stat = await waitForCall(harness, 0);
    expect(stat.timeout).toBe(5_000);
    await vi.advanceTimersByTimeAsync(2_000);
    completeStat(stat);
    await pending;
    expect(harness.calls[1]?.timeout).toBe(3_000);
  });

  it("still caps stat at 10s when timeoutMs is omitted", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, completeStat);
    harness.onCall(1, completeCat);

    await drainReadStream(adapter.readStream({ path: "/tmp/a.bin", sandboxId: "sbx" }));
    expect(harness.calls[0]?.timeout).toBe(STAT_INTEGRITY_TIMEOUT_MS);
    expect(harness.calls[1]?.timeout).toBeUndefined();
  });

  it("starts unbounded cat after a hung best-effort stat when timeoutMs is omitted", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, () => undefined);
    harness.onCall(1, completeCat);

    const pending = drainReadStream(adapter.readStream({ path: "/tmp/a.bin", sandboxId: "sbx" }));
    await waitForCall(harness, 0);
    await vi.advanceTimersByTimeAsync(STAT_INTEGRITY_TIMEOUT_MS);
    await pending;
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.timeout).toBe(STAT_INTEGRITY_TIMEOUT_MS);
    expect(harness.calls[1]?.timeout).toBeUndefined();
    expect(initCommand(harness.calls[1]?.sent ?? [])).toEqual(
      expect.arrayContaining(["cwsandbox-read-file-streaming", "/tmp/a.bin"]),
    );
  });

  it("throws CWSandboxTimeoutError without RPCs when timeoutMs is 0", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);

    await expect(
      drainReadStream(adapter.readStream({ path: "/tmp/a.bin", sandboxId: "sbx", timeoutMs: 0 })),
    ).rejects.toMatchObject({
      name: "CWSandboxTimeoutError",
      operation: "Read file",
      sandboxId: "sbx",
    });
    expect(harness.calls).toHaveLength(0);
  });

  it("throws Read file timeout when skip-stat remaining hits 0 before cat", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now");
    now
      .mockReturnValueOnce(t0)
      .mockReturnValueOnce(t0)
      .mockReturnValueOnce(t0 + 1);

    try {
      await expect(
        drainReadStream(
          adapter.readStream({
            expectedSize: 1,
            path: "/tmp/a.bin",
            sandboxId: "sbx",
            timeoutMs: 1,
          }),
        ),
      ).rejects.toMatchObject({
        name: "CWSandboxTimeoutError",
        operation: "Read file",
        sandboxId: "sbx",
      });
      expect(harness.calls).toHaveLength(0);
    } finally {
      now.mockRestore();
    }
  });

  it("times out a hung stat that consumes the full budget without starting cat", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, () => undefined);

    const pending = expect(
      drainReadStream(adapter.readStream({ path: "/tmp/a.bin", sandboxId: "sbx", timeoutMs: 100 })),
    ).rejects.toMatchObject({
      name: "CWSandboxTimeoutError",
      operation: "Read file",
      sandboxId: "sbx",
    });
    await waitForCall(harness, 0);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(harness.calls).toHaveLength(1);
  });

  it("surfaces abort during a hung stat and does not start cat", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, () => undefined);
    const controller = new AbortController();
    const reason = new Error("stop-stat");

    const pending = expect(
      drainReadStream(
        adapter.readStream({
          path: "/tmp/a.bin",
          sandboxId: "sbx",
          signal: controller.signal,
        }),
      ),
    ).rejects.toBe(reason);
    await waitForCall(harness, 0);
    controller.abort(reason);
    await pending;
    expect(harness.calls).toHaveLength(1);
  });

  it("surfaces abort after cat starts with the caller's reason", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, () => undefined);
    const controller = new AbortController();
    const reason = new Error("stop-cat");

    const pending = expect(
      drainReadStream(
        adapter.readStream({
          expectedSize: 1,
          path: "/tmp/a.bin",
          sandboxId: "sbx",
          signal: controller.signal,
        }),
      ),
    ).rejects.toBe(reason);
    await waitForCall(harness, 0);
    controller.abort(reason);
    await pending;
    expect(harness.calls).toHaveLength(1);
  });

  it("does not start the deadline until iteration begins", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, completeStat);
    harness.onCall(1, completeCat);

    const stream = adapter.readStream({
      path: "/tmp/a.bin",
      sandboxId: "sbx",
      timeoutMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.calls).toHaveLength(0);

    await drainReadStream(stream);
    expect(harness.calls[0]?.timeout).toBe(STAT_INTEGRITY_TIMEOUT_MS);
    expect(harness.calls[1]?.timeout).toBe(60_000);
  });

  it("skips stat when expectedSize is provided", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, completeCat);

    await expect(async () => {
      for await (const _chunk of adapter.readStream({
        expectedSize: TRUNCATION_CHECK_MIN_BYTES,
        path: "/tmp/big.bin",
        sandboxId: "sbx",
      })) {
        // drain
      }
    }).rejects.toMatchObject({
      name: "CWSandboxFileError",
      reason: CWSANDBOX_FILE_TRUNCATED,
    });
    expect(harness.calls).toHaveLength(1);
    expect(initCommand(harness.calls[0]?.sent ?? [])).toEqual(
      expect.arrayContaining(["cwsandbox-read-file-streaming", "/tmp/big.bin"]),
    );
  });

  it("remaps a cat RPC deadline to operation Read file", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, () => undefined);

    const pending = expect(
      drainReadStream(
        adapter.readStream({
          expectedSize: 10,
          path: "/tmp/a.bin",
          sandboxId: "sbx",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toMatchObject({
      name: "CWSandboxTimeoutError",
      operation: "Read file",
      sandboxId: "sbx",
    });
    await waitForCall(harness, 0);
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(harness.calls).toHaveLength(1);
  });

  it("remaps an init-frame deadline to operation Read file", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, (duplex) => {
      duplex.rejectSend(new RpcError("deadline", "DEADLINE_EXCEEDED"));
    });

    await expect(
      drainReadStream(
        adapter.readStream({
          expectedSize: 10,
          path: "/tmp/a.bin",
          sandboxId: "sbx",
        }),
      ),
    ).rejects.toMatchObject({
      name: "CWSandboxTimeoutError",
      operation: "Read file",
      sandboxId: "sbx",
    });
    expect(harness.calls).toHaveLength(1);
  });

  it("caps stderr bytes and drops a split UTF-8 tail", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    const euro = new Uint8Array([0xe2, 0x82, 0xac]);
    const euroTail = euro.subarray(1);
    harness.onCall(0, (duplex) => {
      duplex.push(readyFrame());
      duplex.push(stderrBytesFrame(new Uint8Array(STREAMING_READ_STDERR_CAP_BYTES - 1).fill(0x78)));
      duplex.push(stderrBytesFrame(euro.subarray(0, 1)));
      duplex.push(stderrBytesFrame(euroTail));
      duplex.push(stderrBytesFrame(new TextEncoder().encode("UNIQUE_TAIL")));
      duplex.push(exitFrame(1));
      duplex.end();
    });

    await expect(
      drainReadStream(
        adapter.readStream({
          expectedSize: 1,
          path: "/tmp/fail.bin",
          sandboxId: "sbx",
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof Error &&
        error.name === "CWSandboxFileError" &&
        !error.message.includes("UNIQUE_TAIL")
      );
    });
  });

  it("keeps typed missing-file mapping when stderr exceeds the cap", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, (duplex) => {
      duplex.push(readyFrame());
      duplex.push(
        stderrBytesFrame(new Uint8Array(STREAMING_READ_STDERR_CAP_BYTES + 32).fill(0x78)),
      );
      duplex.push(exitFrame(2));
      duplex.end();
    });

    await expect(
      drainReadStream(
        adapter.readStream({
          expectedSize: 1,
          path: "/tmp/missing.bin",
          sandboxId: "sbx",
        }),
      ),
    ).rejects.toMatchObject({
      name: "CWSandboxFileError",
      reason: CWSANDBOX_FILE_NOT_FOUND,
    });
  });

  it("keeps typed directory mapping when stderr exceeds the cap", async () => {
    const harness = createStreamingHarness();
    const adapter = createGrpcFileAdapter(harness.clients);
    harness.onCall(0, (duplex) => {
      duplex.push(readyFrame());
      duplex.push(
        stderrBytesFrame(new Uint8Array(STREAMING_READ_STDERR_CAP_BYTES + 32).fill(0x78)),
      );
      duplex.push(exitFrame(3));
      duplex.end();
    });

    await expect(
      drainReadStream(
        adapter.readStream({
          expectedSize: 1,
          path: "/tmp/dir",
          sandboxId: "sbx",
        }),
      ),
    ).rejects.toMatchObject({
      name: "CWSandboxFileError",
      reason: CWSANDBOX_FILE_IS_DIRECTORY,
    });
  });
});

function initCommand(sent: readonly ExecStreamRequest[]): string[] {
  const init = sent.find((message) => message.message.oneofKind === "init");
  if (init?.message.oneofKind !== "init") {
    return [];
  }
  return [...init.message.init.command];
}

function readyFrame(_sessionId?: string): ExecStreamResponse {
  return {
    message: {
      oneofKind: "ready",
      ready: {},
    },
  };
}

function exitFrame(exitCode: number): ExecStreamResponse {
  return {
    message: {
      exit: { exitCode },
      oneofKind: "exit",
    },
  };
}

function stdoutFrame(data: string | Uint8Array): ExecStreamResponse {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return {
    message: {
      oneofKind: "output",
      output: {
        data: bytes,
        stream: ProtoExecStreamOutputStream.STDOUT,
      },
    },
  };
}

function stderrFrame(message: string): ExecStreamResponse {
  return stderrBytesFrame(new TextEncoder().encode(message));
}

function stderrBytesFrame(data: Uint8Array): ExecStreamResponse {
  return {
    message: {
      oneofKind: "output",
      output: {
        data,
        stream: ProtoExecStreamOutputStream.STDERR,
      },
    },
  };
}

function completeStat(duplex: MockDuplex, size = "10"): void {
  duplex.push(stdoutFrame(size));
  duplex.push(exitFrame(0));
  duplex.end();
}

function completeCat(duplex: MockDuplex): void {
  duplex.push(readyFrame());
  duplex.push(stdoutFrame(new Uint8Array([1])));
  duplex.push(exitFrame(0));
  duplex.end();
}

async function drainReadStream(stream: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

async function waitForCall(harness: { calls: MockDuplex[] }, index: number): Promise<MockDuplex> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const call = harness.calls[index];
    if (call !== undefined) {
      return call;
    }
    await Promise.resolve();
  }
  throw new Error(`StreamExec call ${index} did not start.`);
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
  readonly timeout: number | undefined;
  end(): void;
  push(response: ExecStreamResponse): void;
  rejectSend(reason: unknown): void;
}

function createStreamingHarness(): {
  readonly calls: MockDuplex[];
  readonly clients: GrpcClients;
  onCall(index: number, setup: (duplex: MockDuplex) => void): void;
} {
  const setups = new Map<number, (duplex: MockDuplex) => void>();
  const calls: MockDuplex[] = [];
  let nextIndex = 0;

  const client = {
    streamExec(options?: RpcOptions) {
      const timeoutMs = typeof options?.timeout === "number" ? options.timeout : undefined;
      const duplex = createMockDuplex(options?.abort, timeoutMs);
      const index = nextIndex;
      nextIndex += 1;
      calls.push(duplex);
      setups.get(index)?.(duplex);
      return duplex.call;
    },
  } as unknown as SandboxServiceClient;

  return {
    calls,
    clients: {
      client,
    },
    onCall(index, setup) {
      setups.set(index, setup);
    },
  };
}

function createMockDuplex(
  abort?: AbortSignal,
  timeoutMs?: number,
): MockDuplex & {
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
  let sendError: unknown;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDrain!: () => void;
  const drainPromise = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });

  const failWaiters = (reason: unknown): void => {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    aborted = true;
    abortError = reason;
    while (rejecters.length > 0) {
      rejecters.shift()?.(reason);
    }
    waiters.length = 0;
    resolveDrain();
  };

  if (timeoutMs !== undefined && timeoutMs <= 0) {
    failWaiters(new RpcError("deadline", "DEADLINE_EXCEEDED"));
  } else if (timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => {
      failWaiters(new RpcError("deadline", "DEADLINE_EXCEEDED"));
    }, timeoutMs);
  }

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
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
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
          if (sendError !== undefined) {
            throw sendError;
          }
        },
      },
      responses,
      status: Promise.resolve({ code: "OK", detail: "" }),
    },
    drainPromise,
    end,
    push,
    rejectSend(reason: unknown) {
      sendError = reason;
    },
    sent,
    timeout: timeoutMs,
  };
}
