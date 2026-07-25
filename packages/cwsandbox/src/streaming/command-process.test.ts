// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxExecutionError,
  CWSandboxTimeoutError,
  CWSandboxValidationError,
} from "../errors.js";
import { STREAMING_OUTPUT_QUEUE_SIZE } from "../internal/file-limits.js";
import { createCommandProcess, type CommandInputController } from "./command-process.js";

describe("CommandProcess", () => {
  it("tracks process status and exit code", async () => {
    const controller = createCommandProcess(["python"]);

    expect(controller.process.status).toBe("starting");
    expect(controller.process.exitCode).toBeUndefined();
    expect(controller.process.poll()).toBeUndefined();

    await controller.dispatch({ sessionId: "session-1", type: "ready" });
    expect(controller.process.status).toBe("running");

    await controller.dispatch({ exitCode: 0, type: "exit" });
    expect(controller.process.status).toBe("exited");
    expect(controller.process.exitCode).toBe(0);
    expect(controller.process.poll()).toBe(0);
  });

  it("fans out stdout and stderr chunks", async () => {
    const controller = createCommandProcess(["python"]);
    const stdout = collect(controller.process.stdout);
    const stderr = collect(controller.process.stderr);

    await controller.dispatch({ sessionId: "session-1", type: "ready" });
    await controller.dispatch({ data: new TextEncoder().encode("out"), type: "stdout" });
    await controller.dispatch({ data: new TextEncoder().encode("err"), type: "stderr" });
    await controller.dispatch({ exitCode: 0, type: "exit" });

    await expect(stdout).resolves.toEqual(["out"]);
    await expect(stderr).resolves.toEqual(["err"]);
  });

  it("returns accumulated output from wait", async () => {
    const controller = createCommandProcess(["python"]);

    await controller.dispatch({ data: new TextEncoder().encode("out"), type: "stdout" });
    await controller.dispatch({ data: new TextEncoder().encode("err"), type: "stderr" });
    await controller.dispatch({ exitCode: 7, type: "exit" });

    await expect(controller.process.wait()).resolves.toEqual({
      command: ["python"],
      exitCode: 7,
      failed: true,
      ok: false,
      stderr: "err",
      stderrBytes: new TextEncoder().encode("err"),
      stderrBytesProduced: 3,
      stderrTruncated: false,
      stdout: "out",
      stdoutBytes: new TextEncoder().encode("out"),
      stdoutBytesProduced: 3,
      stdoutTruncated: false,
    });
  });

  it("binaryOutput skips decoding stdout text while keeping stdoutBytes", async () => {
    const controller = createCommandProcess(["python"], { binaryOutput: true });
    const payload = new Uint8Array([0, 159, 146, 150, 1, 2, 3]);
    const binary = collect(controller.process.stdoutBinary);

    await controller.dispatch({ data: payload, type: "stdout" });
    await controller.dispatch({ data: new TextEncoder().encode("oops"), type: "stderr" });
    await controller.dispatch({ exitCode: 0, type: "exit" });

    const result = await controller.process.wait();
    expect(result.stdout).toBe("");
    expect(result.stdoutBytes).toEqual(payload);
    expect(result.stderr).toBe("oops");
    expect(result.stderrBytes).toEqual(new TextEncoder().encode("oops"));
    await expect(binary).resolves.toEqual([payload]);
  });

  it("streamStdoutOnly exposes stdoutBinary without accumulating wait().stdoutBytes", async () => {
    const controller = createCommandProcess(["python"], {
      binaryOutput: true,
      streamStdoutOnly: true,
    });
    const chunkA = new Uint8Array([1, 2, 3]);
    const chunkB = new Uint8Array([4, 5]);
    const binary = collect(controller.process.stdoutBinary);

    await controller.dispatch({ data: chunkA, type: "stdout" });
    await controller.dispatch({ data: chunkB, type: "stdout" });
    await controller.dispatch({ exitCode: 0, type: "exit" });

    const result = await controller.process.wait();
    expect(result.stdoutBytes).toEqual(new Uint8Array());
    expect(result.stdoutBytesProduced).toBe(5);
    expect(result.stdoutTruncated).toBe(false);
    await expect(binary).resolves.toEqual([chunkA, chunkB]);
  });

  it("applies backpressure on stdoutBinary instead of silently dropping frames", async () => {
    const controller = createCommandProcess(["python"], {
      binaryOutput: true,
      streamStdoutOnly: true,
    });
    const frameCount = STREAMING_OUTPUT_QUEUE_SIZE + 1;
    const producer = (async () => {
      for (let index = 0; index < frameCount; index += 1) {
        await controller.dispatch({
          data: new Uint8Array([index % 256]),
          type: "stdout",
        });
      }
      await controller.dispatch({ exitCode: 0, type: "exit" });
    })();

    // Let the producer fill the queue before the consumer starts draining.
    await Promise.resolve();
    await Promise.resolve();

    const chunks = await collect(controller.process.stdoutBinary);
    await producer;

    expect(chunks).toHaveLength(frameCount);
    expect(chunks.map((chunk) => chunk[0])).toEqual(
      Array.from({ length: frameCount }, (_, index) => index % 256),
    );
    await expect(controller.process.wait()).resolves.toMatchObject({ exitCode: 0 });
  });

  it("rejects wait for checked non-zero exits while preserving status and exit code", async () => {
    const controller = createCommandProcess(["python"], { check: true });

    await controller.dispatch({ data: new TextEncoder().encode("out"), type: "stdout" });
    await controller.dispatch({ data: new TextEncoder().encode("err"), type: "stderr" });
    await controller.dispatch({ exitCode: 7, type: "exit" });

    expect(controller.process.status).toBe("exited");
    expect(controller.process.exitCode).toBe(7);
    expect(controller.process.poll()).toBe(7);
    await expect(controller.process.wait()).rejects.toMatchObject({
      name: "CWSandboxExecutionError",
      result: {
        command: ["python"],
        exitCode: 7,
        failed: true,
        ok: false,
        stderr: "err",
        stdout: "out",
      },
    });
    await expect(controller.process.wait()).rejects.toBeInstanceOf(CWSandboxExecutionError);
  });

  it("wait is idempotent", async () => {
    const controller = createCommandProcess(["python"]);

    await controller.dispatch({ exitCode: 0, type: "exit" });

    await expect(controller.process.wait()).resolves.toBe(await controller.process.wait());
  });

  it("supports timeout and abort options while waiting", async () => {
    const timeoutController = createCommandProcess(["python"]);
    await expect(timeoutController.process.wait({ timeoutMs: 1 })).rejects.toThrow(
      CWSandboxTimeoutError,
    );

    const abortController = new AbortController();
    const abortReason = new Error("aborted");
    abortController.abort(abortReason);

    await expect(
      createCommandProcess(["python"]).process.wait({ signal: abortController.signal }),
    ).rejects.toBe(abortReason);
  });

  it("validates wait options", async () => {
    const controller = createCommandProcess(["python"]);

    await expect(controller.process.wait({ timeoutMs: -1 })).rejects.toThrow(
      CWSandboxValidationError,
    );
  });

  it("propagates stream errors and wait rejection", async () => {
    const controller = createCommandProcess(["python"]);
    const error = new Error("stream failed");
    const stdout = collect(controller.process.stdout);

    await controller.dispatch({ error, type: "error" });

    expect(controller.process.status).toBe("failed");
    await expect(stdout).rejects.toBe(error);
    await expect(controller.process.wait()).rejects.toBe(error);
  });

  it("wait completes when stderr is not consumed", async () => {
    const controller = createCommandProcess(["python"]);
    const stdout = collect(controller.process.stdout);

    await controller.dispatch({ data: new TextEncoder().encode("out"), type: "stdout" });
    await controller.dispatch({ data: new TextEncoder().encode("err"), type: "stderr" });
    await controller.dispatch({ exitCode: 0, type: "exit" });

    await expect(stdout).resolves.toEqual(["out"]);
    await expect(controller.process.wait()).resolves.toMatchObject({
      exitCode: 0,
      failed: false,
      ok: true,
      stderr: "err",
      stdout: "out",
    });
  });

  it("tracks truncation metadata from buffered caps", async () => {
    const controller = createCommandProcess(["python"], { bufferedMaxKiB: 1 });
    const output = "x".repeat(2048);

    await controller.dispatch({ data: new TextEncoder().encode(output), type: "stdout" });
    await controller.dispatch({ exitCode: 0, type: "exit" });

    await expect(controller.process.wait()).resolves.toMatchObject({
      stdout: "x".repeat(1024),
      stdoutBytesProduced: 2048,
      stdoutTruncated: true,
    });
  });

  it("wait completes after more unconsumed chunks than the stream queue capacity", async () => {
    const controller = createCommandProcess(["python"], { bufferedMaxKiB: 1 });
    const chunk = new TextEncoder().encode("x".repeat(32));

    for (let index = 0; index < 128; index += 1) {
      await controller.dispatch({ data: chunk, type: "stdout" });
    }
    await controller.dispatch({ exitCode: 0, type: "exit" });

    await expect(controller.process.wait()).resolves.toMatchObject({
      exitCode: 0,
      stdoutBytesProduced: 4096,
      stdoutTruncated: true,
    });
  });

  it("writes string, line, and byte stdin chunks in order", async () => {
    const input = createTrackingInputController();
    const controller = createCommandProcess(["cat"], { input, stdin: true });

    await controller.process.stdin.write("hello");
    await controller.process.stdin.writeln(" world");
    await controller.process.stdin.write(new Uint8Array([33]));
    await controller.process.stdin.close();

    expect(input.writes.map((chunk) => new TextDecoder().decode(chunk))).toEqual([
      "hello",
      " world\n",
      "!",
    ]);
    expect(input.closeCalls).toBe(1);
    expect(controller.process.stdin.closed).toBe(true);
  });

  it("closes stdin idempotently and rejects writes after close", async () => {
    const input = createTrackingInputController();
    const controller = createCommandProcess(["cat"], { input, stdin: true });

    await controller.process.stdin.close();
    await controller.process.stdin.close();

    expect(input.closeCalls).toBe(1);
    await expect(controller.process.stdin.write("late")).rejects.toThrow(CWSandboxValidationError);
  });

  it("rejects invalid stdin input and writes after terminal process states", async () => {
    const controller = createCommandProcess(["cat"], {
      input: createTrackingInputController(),
      stdin: true,
    });

    await expect(controller.process.stdin.write(123 as unknown as string)).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(controller.process.stdin.writeln(123 as unknown as string)).rejects.toThrow(
      CWSandboxValidationError,
    );

    await controller.dispatch({ exitCode: 0, type: "exit" });
    await expect(controller.process.stdin.write("late")).rejects.toThrow(CWSandboxValidationError);
  });

  it("waits for output while stdin remains open", async () => {
    const controller = createCommandProcess(["cat"], {
      input: createTrackingInputController(),
      stdin: true,
    });

    await controller.process.stdin.write("input");
    await controller.dispatch({ data: new TextEncoder().encode("output"), type: "stdout" });
    await controller.dispatch({ exitCode: 0, type: "exit" });

    await expect(controller.process.wait()).resolves.toMatchObject({
      exitCode: 0,
      stdout: "output",
    });
  });

  it("cancels the command process and rejects wait and streams", async () => {
    const input = createTrackingInputController();
    const controller = createCommandProcess(["cat"], { input, stdin: true });
    const stdout = collect(controller.process.stdout);

    await controller.process.cancel();

    expect(controller.process.status).toBe("cancelled");
    expect(controller.process.stdin.closed).toBe(true);
    expect(input.cancelCalls).toBe(1);
    await expect(controller.process.wait()).rejects.toThrow("Streaming command cancelled.");
    await expect(stdout).rejects.toThrow("Streaming command cancelled.");
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of stream) {
    values.push(value);
  }

  return values;
}

function createTrackingInputController(): CommandInputController & {
  readonly cancelCalls: number;
  readonly closeCalls: number;
  readonly writes: Uint8Array[];
} {
  const writes: Uint8Array[] = [];
  let cancelCalls = 0;
  let closeCalls = 0;

  return {
    get cancelCalls() {
      return cancelCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
    writes,
    async cancel() {
      cancelCalls += 1;
    },
    async close() {
      closeCalls += 1;
    },
    async write(data) {
      writes.push(data);
    },
  };
}
