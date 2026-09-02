// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it, vi } from "vitest";

import { mapWithConcurrency } from "./map-concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns empty results for an empty input", async () => {
    await expect(mapWithConcurrency([], 2, async (value) => value)).resolves.toEqual([]);
  });

  it("keeps result order and never exceeds the concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];

    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      started.push(value);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return value * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("starts the next item when a worker frees while another is still held", async () => {
    const started: number[] = [];
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;

    const mapped = mapWithConcurrency(["a", "b", "c"], 2, async (value, index) => {
      started.push(index);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      inFlight -= 1;
      return value;
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    expect(peak).toBe(2);
    expect(releases).toHaveLength(2);

    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    expect(releases).toHaveLength(2);
    expect(peak).toBe(2);

    while (releases.length > 0) {
      releases.shift()?.();
    }
    await expect(mapped).resolves.toEqual(["a", "b", "c"]);
  });
});
