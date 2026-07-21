// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxTimeoutError, CWSandboxValidationError } from "../errors.js";
import { createTerminalSession, type TerminalInputController } from "./terminal-session.js";

describe("TerminalSession", () => {
  it("tracks status, exit code, and wait result", async () => {
    const controller = createTerminalSession(["/bin/sh"], createTrackingInputController());

    expect(controller.session.status).toBe("starting");
    expect(controller.session.exitCode).toBeUndefined();
    expect(controller.session.poll()).toBeUndefined();

    await controller.dispatch({ sessionId: "session-1", type: "ready" });
    expect(controller.session.status).toBe("running");

    await controller.dispatch({ exitCode: 0, type: "exit" });

    expect(controller.session.status).toBe("exited");
    expect(controller.session.exitCode).toBe(0);
    expect(controller.session.poll()).toBe(0);
    await expect(controller.session.wait()).resolves.toEqual({
      command: ["/bin/sh"],
      exitCode: 0,
    });
  });

  it("streams raw byte output", async () => {
    const controller = createTerminalSession(["/bin/sh"], createTrackingInputController());
    const output = collect(controller.session.output);
    const bytes = new Uint8Array([27, 91, 51, 49, 109]);

    await controller.dispatch({ data: bytes, type: "output" });
    await controller.dispatch({ exitCode: 0, type: "exit" });

    await expect(output).resolves.toEqual([bytes]);
  });

  it("forwards stdin writes and resize requests", async () => {
    const input = createTrackingInputController();
    const controller = createTerminalSession(["/bin/sh"], input);

    await controller.session.stdin.write("echo hello");
    await controller.session.stdin.writeln(" world");
    await controller.session.stdin.write(new Uint8Array([3]));
    await controller.session.resize(120, 40);
    await controller.session.stdin.close();

    expect(input.writes.map((chunk) => new TextDecoder().decode(chunk))).toEqual([
      "echo hello",
      " world\n",
      "\u0003",
    ]);
    expect(input.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(input.closeCalls).toBe(1);
    expect(controller.session.stdin.closed).toBe(true);
  });

  it("supports timeout and abort options while waiting", async () => {
    await expect(
      createTerminalSession(["/bin/sh"], createTrackingInputController()).session.wait({
        timeoutMs: 1,
      }),
    ).rejects.toThrow(CWSandboxTimeoutError);

    const abortController = new AbortController();
    const abortReason = new Error("aborted");
    abortController.abort(abortReason);

    await expect(
      createTerminalSession(["/bin/sh"], createTrackingInputController()).session.wait({
        signal: abortController.signal,
      }),
    ).rejects.toBe(abortReason);
  });

  it("cancels the terminal session and rejects wait and output", async () => {
    const input = createTrackingInputController();
    const controller = createTerminalSession(["/bin/sh"], input);
    const output = collect(controller.session.output);

    await controller.session.cancel();

    expect(controller.session.status).toBe("cancelled");
    expect(controller.session.stdin.closed).toBe(true);
    expect(input.cancelCalls).toBe(1);
    await expect(controller.session.wait()).rejects.toThrow("Terminal session cancelled.");
    await expect(output).rejects.toThrow("Terminal session cancelled.");
  });

  it("validates stdin data and resize dimensions", async () => {
    const controller = createTerminalSession(["/bin/sh"], createTrackingInputController());

    await expect(controller.session.stdin.write(123 as unknown as string)).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(controller.session.stdin.writeln(123 as unknown as string)).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(controller.session.resize(0, 24)).rejects.toThrow(CWSandboxValidationError);
    await expect(controller.session.resize(80, 1.5)).rejects.toThrow(CWSandboxValidationError);

    await controller.dispatch({ exitCode: 0, type: "exit" });
    await expect(controller.session.stdin.write("late")).rejects.toThrow(CWSandboxValidationError);
    await expect(controller.session.resize(80, 24)).rejects.toThrow(CWSandboxValidationError);
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of stream) {
    values.push(value);
  }

  return values;
}

function createTrackingInputController(): TerminalInputController & {
  readonly cancelCalls: number;
  readonly closeCalls: number;
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }>;
  readonly writes: Uint8Array[];
} {
  const resizes: Array<{ readonly cols: number; readonly rows: number }> = [];
  const writes: Uint8Array[] = [];
  let cancelCalls = 0;
  let closeCalls = 0;

  return {
    get cancelCalls() {
      return cancelCalls;
    },
    async cancel() {
      cancelCalls += 1;
    },
    async close() {
      closeCalls += 1;
    },
    get closeCalls() {
      return closeCalls;
    },
    async resize(cols, rows) {
      resizes.push({ cols, rows });
    },
    resizes,
    async write(data) {
      writes.push(data);
    },
    writes,
  };
}
