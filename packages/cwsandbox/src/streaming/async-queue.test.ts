// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { AsyncQueue } from "./async-queue.js";

describe("AsyncQueue", () => {
  it("yields pushed chunks in order", async () => {
    const queue = new AsyncQueue<string>();

    await queue.push("a");
    await queue.push("b");
    queue.close();

    await expect(collect(queue)).resolves.toEqual(["a", "b"]);
  });

  it("fails pending consumers", async () => {
    const queue = new AsyncQueue<string>();
    const error = new Error("boom");
    const result = collect(queue);

    queue.fail(error);

    await expect(result).rejects.toBe(error);
  });

  it("unblocks pending consumers on close", async () => {
    const queue = new AsyncQueue<string>();
    const result = collect(queue);

    queue.close();

    await expect(result).resolves.toEqual([]);
  });

  it("applies backpressure when capacity is reached", async () => {
    const queue = new AsyncQueue<string>(1);
    await queue.push("a");
    let pushed = false;

    const pendingPush = queue.push("b").then(() => {
      pushed = true;
    });
    await Promise.resolve();

    expect(pushed).toBe(false);

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "a" });
    await pendingPush;

    expect(pushed).toBe(true);

    queue.close();
  });

  it("drops non-blocking pushes when capacity is reached", async () => {
    const queue = new AsyncQueue<string>(1);

    expect(queue.tryPush("a")).toBe(true);
    expect(queue.tryPush("b")).toBe(false);
    queue.close();

    await expect(collect(queue)).resolves.toEqual(["a"]);
  });

  it("rejects multiple consumers", async () => {
    const queue = new AsyncQueue<string>();
    queue[Symbol.asyncIterator]();

    expect(() => queue[Symbol.asyncIterator]()).toThrow("Stream already has a consumer.");
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of stream) {
    values.push(value);
  }

  return values;
}
