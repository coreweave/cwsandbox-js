// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxTransportError } from "../errors.js";
import { createLogStream, type LogStreamControls } from "./log-stream.js";

describe("LogStream", () => {
  it("yields complete lines across split chunks", async () => {
    const controller = createLogStream("lines", createControls());
    const lines = collect(controller.stream);

    await controller.dispatch({
      data: new TextEncoder().encode("hello"),
      offset: "5",
      sessionId: "session-1",
      type: "data",
    });
    await controller.dispatch({
      data: new TextEncoder().encode(" world\nnext"),
      offset: "16",
      sessionId: "session-1",
      type: "data",
    });
    await controller.dispatch({ type: "complete" });

    await expect(lines).resolves.toEqual(["hello world\n", "next"]);
    expect(controller.stream.sessionId).toBe("session-1");
    expect(controller.stream.offset).toBe("16");
  });

  it("flushes long newline-free output", async () => {
    const controller = createLogStream("lines", createControls());
    const lines = collect(controller.stream);

    await controller.dispatch({
      data: new TextEncoder().encode("x".repeat(65 * 1024)),
      type: "data",
    });
    await controller.dispatch({ type: "complete" });

    const result = await lines;
    expect(result.join("").length).toBe(65 * 1024);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("yields structured entries with metadata", async () => {
    const controller = createLogStream("entries", createControls());
    const entries = collect(controller.stream);

    await controller.dispatch({
      data: new TextEncoder().encode("entry\n"),
      offset: "6",
      sessionId: "session-1",
      timestamp: { nanos: 123_000_000, seconds: "1700000000" },
      type: "data",
    });
    await controller.dispatch({ type: "complete" });

    await expect(entries).resolves.toEqual([
      {
        line: "entry\n",
        offset: "6",
        sessionId: "session-1",
        timestamp: new Date(1_700_000_000_123),
      },
    ]);
  });

  it("yields raw chunks with bytes and decoded text", async () => {
    const controller = createLogStream("raw", createControls());
    const chunks = collect(controller.stream);
    const data = new Uint8Array([104, 105]);

    await controller.dispatch({
      data,
      offset: "2",
      sessionId: "session-1",
      type: "data",
    });
    await controller.dispatch({ type: "complete" });

    await expect(chunks).resolves.toEqual([
      {
        data,
        offset: "2",
        sessionId: "session-1",
        text: "hi",
      },
    ]);
  });

  it("propagates backend errors to consumers", async () => {
    const controller = createLogStream("lines", createControls());
    const lines = collect(controller.stream);
    const error = new CWSandboxTransportError("log failed");

    await controller.dispatch({ error, type: "error" });

    await expect(lines).rejects.toBe(error);
    expect(controller.stream.closed).toBe(true);
  });

  it("closes and cancels idempotently", async () => {
    const controls = createControls();
    const controller = createLogStream("lines", controls);

    await controller.stream.close();
    await controller.stream.close();

    expect(controls.closeCalls).toBe(1);
    expect(controller.stream.closed).toBe(true);

    const cancelController = createLogStream("lines", controls);
    await cancelController.stream.cancel();
    await cancelController.stream.cancel();

    expect(controls.cancelCalls).toBe(1);
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of stream) {
    values.push(value);
  }

  return values;
}

function createControls(): LogStreamControls & {
  readonly cancelCalls: number;
  readonly closeCalls: number;
} {
  let cancelCalls = 0;
  let closeCalls = 0;

  return {
    get cancelCalls() {
      return cancelCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
    async cancel() {
      cancelCalls += 1;
    },
    async close() {
      closeCalls += 1;
    },
  };
}
