// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";
import { describe, expect, it, vi } from "vitest";

import { CWSandboxTransportError } from "../../errors.js";
import type { LogStream } from "../../public/logs.js";
import type { SandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";
import type { LogEntry } from "./generated/coreweave/sandbox/v1/sandbox.js";
import { startGrpcLogStream } from "./log-stream.js";

const textEncoder = new TextEncoder();

describe("startGrpcLogStream", () => {
  it("maps log lines and completes when the server stream ends", async () => {
    const stream = createMockLogStream();
    const logs = (await startGrpcLogStream(stream.client, {
      mode: "lines",
      sandboxId: "sbx",
    })) as LogStream;

    stream.push(logData("hello\n"));
    stream.end();

    await expect(collectLines(logs)).resolves.toEqual(["hello\n"]);
  });

  it("releases its transport lease when the stream ends", async () => {
    const stream = createMockLogStream();
    const onSettled = vi.fn<() => Promise<void>>(async () => undefined);
    const logs = (await startGrpcLogStream(
      stream.client,
      { mode: "lines", sandboxId: "sbx" },
      onSettled,
    )) as LogStream;

    stream.end();
    await collectLines(logs);

    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });

  it("maps an in-band stream error", async () => {
    const stream = createMockLogStream();
    const logs = (await startGrpcLogStream(stream.client, {
      mode: "lines",
      sandboxId: "sbx",
    })) as LogStream;

    stream.push(
      logData("", {
        error: { code: "SESSION_NOT_FOUND", message: "gone" },
      }),
    );

    await expect(collectLines(logs)).rejects.toThrow(CWSandboxTransportError);
  });

  it("maps a status rejection after responses finish", async () => {
    const stream = createMockLogStream();
    const logs = (await startGrpcLogStream(stream.client, {
      mode: "lines",
      sandboxId: "sbx",
    })) as LogStream;

    stream.push(logData("hello\n"));
    stream.end(new RpcError("status failed", "INTERNAL"));

    await expect(collectLines(logs)).rejects.toThrow(CWSandboxTransportError);
  });

  it("maps a response-iterator rejection while status resolves", async () => {
    const stream = createMockLogStream();
    const logs = (await startGrpcLogStream(stream.client, {
      mode: "lines",
      sandboxId: "sbx",
    })) as LogStream;

    const pending = collectLines(logs);
    stream.failResponses(new RpcError("iterator failed", "UNAVAILABLE"));

    await expect(pending).rejects.toThrow(CWSandboxTransportError);
  });

  it("does not throw when close is called during iteration", async () => {
    const stream = createMockLogStream();
    const logs = (await startGrpcLogStream(stream.client, {
      mode: "lines",
      sandboxId: "sbx",
    })) as LogStream;

    const lines: string[] = [];
    const iteration = (async () => {
      for await (const line of logs) {
        lines.push(line);
        await logs.close();
      }
    })();

    stream.push(logData("hello\n"));
    await expect(iteration).resolves.toBeUndefined();
    expect(lines[0]).toBe("hello\n");
    expect(stream.aborted).toBe(true);
  });

  it("does not throw when cancel is called during iteration", async () => {
    const stream = createMockLogStream();
    const logs = (await startGrpcLogStream(stream.client, {
      mode: "lines",
      sandboxId: "sbx",
    })) as LogStream;

    const lines: string[] = [];
    const iteration = (async () => {
      for await (const line of logs) {
        lines.push(line);
        await logs.cancel();
      }
    })();

    stream.push(logData("hello\n"));
    await iteration;

    expect(lines).toEqual(["hello\n"]);
    expect(stream.aborted).toBe(true);
  });

  it("does not throw when an in-band error is queued after caller abort", async () => {
    const stream = createMockLogStream();
    const logs = (await startGrpcLogStream(stream.client, {
      mode: "lines",
      sandboxId: "sbx",
    })) as LogStream;

    const pending = collectLines(logs);
    stream.deliverInBandErrorOnAbort(
      logData("", {
        error: { code: "SESSION_NOT_FOUND", message: "gone" },
      }),
    );
    await logs.close();
    await expect(pending).resolves.toEqual([]);
  });

  it("throws when an unexpected request signal aborts the stream", async () => {
    const abort = new AbortController();
    const stream = createMockLogStream();
    const logs = (await startGrpcLogStream(stream.client, {
      mode: "lines",
      sandboxId: "sbx",
      signal: abort.signal,
    })) as LogStream;

    const pending = collectLines(logs);
    abort.abort(new Error("external abort"));

    await expect(pending).rejects.toThrow(CWSandboxTransportError);
  });
});

async function collectLines(logs: LogStream): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of logs) {
    lines.push(line);
  }
  return lines;
}

function logData(text: string, extras: Partial<LogEntry> = {}): LogEntry {
  return {
    data: textEncoder.encode(text),
    logSessionId: extras.logSessionId ?? "",
    nextLogOffset: extras.nextLogOffset ?? "0",
    ...extras,
  };
}

function createMockLogStream(): {
  readonly aborted: boolean;
  readonly client: SandboxServiceClient;
  deliverInBandErrorOnAbort(entry: LogEntry): void;
  end(statusError?: unknown): void;
  failResponses(reason: unknown): void;
  push(entry: LogEntry): void;
} {
  const pending: LogEntry[] = [];
  const waiters: Array<(value: IteratorResult<LogEntry>) => void> = [];
  const rejecters: Array<(reason: unknown) => void> = [];
  let closed = false;
  let aborted = false;
  let abortError: unknown;
  let inBandErrorOnAbort: LogEntry | undefined;
  let statusSettled = false;
  let resolveStatus: (value: { code: string; detail: string }) => void = () => undefined;
  let rejectStatus: (reason: unknown) => void = () => undefined;
  const status = new Promise<{ code: string; detail: string }>((resolve, reject) => {
    resolveStatus = resolve;
    rejectStatus = reject;
  });

  const settleStatusOk = (): void => {
    if (statusSettled) {
      return;
    }
    statusSettled = true;
    resolveStatus({ code: "OK", detail: "" });
  };

  const failWaiters = (reason: unknown): void => {
    aborted = true;
    abortError = reason;
    const inBand = inBandErrorOnAbort;
    inBandErrorOnAbort = undefined;
    if (inBand !== undefined) {
      const waiter = waiters.shift();
      rejecters.shift();
      if (waiter !== undefined) {
        waiter({ done: false, value: inBand });
        return;
      }
      pending.unshift(inBand);
      return;
    }
    while (rejecters.length > 0) {
      rejecters.shift()?.(reason);
    }
    waiters.length = 0;
  };

  const responses: AsyncIterable<LogEntry> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<LogEntry>> {
          if (pending.length > 0) {
            const value = pending.shift();
            if (value === undefined) {
              return Promise.resolve({ done: true, value: undefined });
            }
            return Promise.resolve({ done: false, value });
          }
          if (abortError !== undefined) {
            return Promise.reject(abortError);
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
    streamLogs(_input: unknown, options?: { abort?: AbortSignal }) {
      options?.abort?.addEventListener(
        "abort",
        () => {
          failWaiters(options.abort?.reason ?? new Error("aborted"));
          settleStatusOk();
        },
        { once: true },
      );
      if (options?.abort?.aborted) {
        failWaiters(options.abort.reason ?? new Error("aborted"));
        settleStatusOk();
      }
      return {
        responses,
        status,
      };
    },
  } as unknown as SandboxServiceClient;

  return {
    get aborted() {
      return aborted;
    },
    client,
    deliverInBandErrorOnAbort(entry: LogEntry) {
      inBandErrorOnAbort = entry;
    },
    end(statusError?: unknown) {
      closed = true;
      while (waiters.length > 0) {
        rejecters.shift();
        waiters.shift()?.({ done: true, value: undefined });
      }
      if (statusSettled) {
        return;
      }
      statusSettled = true;
      if (statusError === undefined) {
        resolveStatus({ code: "OK", detail: "" });
        return;
      }
      rejectStatus(statusError);
    },
    failResponses(reason: unknown) {
      failWaiters(reason);
      settleStatusOk();
    },
    push(entry: LogEntry) {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        rejecters.shift();
        waiter({ done: false, value: entry });
        return;
      }
      pending.push(entry);
    },
  };
}
