// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxStreamBackpressureError,
  CWSandboxValidationError,
  STREAM_BACKPRESSURE,
  type CommandInputData,
  type SandboxTransport,
} from "./index.js";
import {
  CWSANDBOX_FILE_IO_FAILED,
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_TRUNCATED,
} from "./internal/error-info.js";
import { TRUNCATION_CHECK_MIN_BYTES } from "./internal/file-limits.js";
import type { InternalCommandProcessWithStdin } from "./internal/start-command-options.js";
import { AsyncQueue } from "./streaming/async-queue.js";
import {
  createClient,
  createCommandInputWriter,
  createCommandProcess,
  createFakeTransport,
  createProcessResult,
} from "./test/helpers.js";

describe("Sandbox files streaming", () => {
  it("writeStream sends iterable chunks over stdin", async () => {
    const stdinChunks: Uint8Array[] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        const process = createCommandProcess(
          request.command,
          true,
        ) as InternalCommandProcessWithStdin;
        const stdin = createCommandInputWriter();
        return {
          ...process,
          status: "running",
          stdin: {
            ...stdin,
            async write(data: CommandInputData) {
              stdinChunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
            },
          },
          async wait() {
            return createProcessResult(request.command, { exitCode: 0 });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.files.writeStream("/tmp/stream.bin", [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4, 5]),
    ]);

    expect(stdinChunks.map((chunk) => Array.from(chunk))).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
  });

  it("writeStream slices a bare Uint8Array into streaming chunks", async () => {
    const stdinChunks: Uint8Array[] = [];
    const payload = new Uint8Array(70 * 1024);
    payload[0] = 9;
    payload[payload.byteLength - 1] = 8;

    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        const process = createCommandProcess(
          request.command,
          true,
        ) as InternalCommandProcessWithStdin;
        const stdin = createCommandInputWriter();
        return {
          ...process,
          status: "running",
          stdin: {
            ...stdin,
            async write(data: CommandInputData) {
              stdinChunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
            },
          },
          async wait() {
            return createProcessResult(request.command, { exitCode: 0 });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.files.writeStream("/tmp/sliced.bin", payload);

    expect(stdinChunks.length).toBeGreaterThan(1);
    expect(stdinChunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(
      payload.byteLength,
    );
    expect(stdinChunks[0]?.[0]).toBe(9);
    expect(stdinChunks.at(-1)?.at(-1)).toBe(8);
  });

  it("writeStream aborts mid-stream and cancels the process", async () => {
    const abortController = new AbortController();
    let cancelled = false;
    let writes = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        const process = createCommandProcess(
          request.command,
          true,
        ) as InternalCommandProcessWithStdin;
        const stdin = createCommandInputWriter();
        return {
          ...process,
          status: "running",
          stdin: {
            ...stdin,
            async write() {
              writes += 1;
              if (writes === 1) {
                abortController.abort();
              }
            },
          },
          async cancel() {
            cancelled = true;
          },
          async wait() {
            return createProcessResult(request.command, { exitCode: 0 });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      yield new Uint8Array([2]);
      yield new Uint8Array([3]);
    }

    await expect(
      sandbox.files.writeStream("/tmp/partial.bin", chunks(), { signal: abortController.signal }),
    ).rejects.toThrow(/aborted|AbortError|This operation was aborted/i);
    expect(cancelled).toBe(true);
  });

  it("writeStream rejects non-Uint8Array chunks with ValidationError", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        const process = createCommandProcess(
          request.command,
          true,
        ) as InternalCommandProcessWithStdin;
        return {
          ...process,
          status: "running",
          async wait() {
            return createProcessResult(request.command, { exitCode: 0 });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(
      sandbox.files.writeStream("/tmp/bad.bin", [123 as unknown as Uint8Array]),
    ).rejects.toBeInstanceOf(CWSandboxValidationError);
  });

  it("writeStream does not remask stream backpressure as a file error", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        const process = createCommandProcess(
          request.command,
          true,
        ) as InternalCommandProcessWithStdin;
        return {
          ...process,
          status: "running",
          async wait() {
            throw new CWSandboxStreamBackpressureError("too slow", {
              streamCode: STREAM_BACKPRESSURE,
            });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(
      sandbox.files.writeStream("/tmp/bp.bin", [new Uint8Array([1])]),
    ).rejects.toBeInstanceOf(CWSandboxStreamBackpressureError);
  });

  it("writeStream maps non-zero exits to CWSANDBOX_FILE_IO_FAILED", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        const process = createCommandProcess(
          request.command,
          true,
        ) as InternalCommandProcessWithStdin;
        return {
          ...process,
          status: "running",
          async wait() {
            return createProcessResult(request.command, {
              exitCode: 1,
              stderr: "permission denied",
            });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(
      sandbox.files.writeStream("/tmp/fail.bin", [new Uint8Array([1])]),
    ).rejects.toMatchObject({
      filepath: "/tmp/fail.bin",
      reason: CWSANDBOX_FILE_IO_FAILED,
    });
  });

  it("readStream yields binary chunks without requiring a full wait buffer", async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    let call = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        call += 1;
        // First call is pre-read stat.
        if (call === 1) {
          const process = createCommandProcess(request.command);
          return {
            ...process,
            async wait() {
              return createProcessResult(request.command, {
                exitCode: 0,
                stdout: String(3),
              });
            },
          };
        }

        const queue = new AsyncQueue<Uint8Array>();
        const [first, second] = chunks;
        if (first === undefined || second === undefined) {
          throw new Error("expected two binary chunks");
        }
        queue.tryPush(first);
        queue.tryPush(second);
        queue.close();
        const process = createCommandProcess(request.command);
        return {
          ...process,
          status: "running",
          stdoutBinary: queue,
          async wait() {
            return createProcessResult(request.command, {
              exitCode: 0,
              stdoutBytes: new Uint8Array(),
              stdoutBytesProduced: 3,
            });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    const received: number[] = [];
    for await (const chunk of sandbox.files.readStream("/tmp/out.bin")) {
      received.push(...chunk);
    }

    expect(received).toEqual([1, 2, 3]);
    expect(call).toBe(2);
  });

  it("readStream maps missing-file exit codes", async () => {
    let call = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        call += 1;
        if (call === 1) {
          const process = createCommandProcess(request.command);
          return {
            ...process,
            async wait() {
              return createProcessResult(request.command, { exitCode: 1, stdout: "" });
            },
          };
        }

        const queue = new AsyncQueue<Uint8Array>();
        queue.close();
        const process = createCommandProcess(request.command);
        return {
          ...process,
          status: "running",
          stdoutBinary: queue,
          async wait() {
            return createProcessResult(request.command, {
              exitCode: 2,
              stderr: "File not found: /missing",
            });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(async () => {
      for await (const _chunk of sandbox.files.readStream("/missing")) {
        // drain
      }
    }).rejects.toMatchObject({
      name: "CWSandboxFileError",
      reason: CWSANDBOX_FILE_NOT_FOUND,
    });
  });

  it("readStream raises truncation when delivered bytes are short of pre-stat size", async () => {
    let call = 0;
    const expected = TRUNCATION_CHECK_MIN_BYTES;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        call += 1;
        if (call === 1) {
          const process = createCommandProcess(request.command);
          return {
            ...process,
            async wait() {
              return createProcessResult(request.command, {
                exitCode: 0,
                stdout: String(expected),
              });
            },
          };
        }

        const queue = new AsyncQueue<Uint8Array>();
        queue.tryPush(new Uint8Array([1, 2, 3]));
        queue.close();
        const process = createCommandProcess(request.command);
        return {
          ...process,
          status: "running",
          stdoutBinary: queue,
          async wait() {
            return createProcessResult(request.command, { exitCode: 0 });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(async () => {
      for await (const _chunk of sandbox.files.readStream("/tmp/big.bin")) {
        // drain
      }
    }).rejects.toMatchObject({
      name: "CWSandboxFileError",
      reason: CWSANDBOX_FILE_TRUNCATED,
    });
  });

  it("readStream does not remask stream backpressure as a file error", async () => {
    let call = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        call += 1;
        if (call === 1) {
          const process = createCommandProcess(request.command);
          return {
            ...process,
            async wait() {
              return createProcessResult(request.command, { exitCode: 0, stdout: "10" });
            },
          };
        }

        const queue = new AsyncQueue<Uint8Array>();
        const process = createCommandProcess(request.command);
        void Promise.resolve().then(() => {
          queue.fail(
            new CWSandboxStreamBackpressureError("too slow", {
              streamCode: STREAM_BACKPRESSURE,
            }),
          );
        });
        return {
          ...process,
          status: "running",
          stdoutBinary: queue,
          async wait() {
            return createProcessResult(request.command, { exitCode: 0 });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(async () => {
      for await (const _chunk of sandbox.files.readStream("/tmp/bp.bin")) {
        // drain
      }
    }).rejects.toBeInstanceOf(CWSandboxStreamBackpressureError);
  });
});
