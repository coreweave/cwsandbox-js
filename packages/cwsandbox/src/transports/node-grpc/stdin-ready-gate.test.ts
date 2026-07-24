// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it, vi } from "vitest";

import { CWSandboxTimeoutError } from "../../errors.js";
import {
  createStdinReadyGate,
  STDIN_READY_TIMEOUT_MS,
  stdinReadyTimeoutMs,
} from "./stdin-ready-gate.js";

describe("stdinReadyTimeoutMs", () => {
  it("defaults to 5 seconds when no operation timeout is set", () => {
    expect(stdinReadyTimeoutMs(undefined)).toBe(STDIN_READY_TIMEOUT_MS);
  });

  it("caps at 5 seconds and otherwise uses the operation timeout", () => {
    expect(stdinReadyTimeoutMs(60_000)).toBe(STDIN_READY_TIMEOUT_MS);
    expect(stdinReadyTimeoutMs(1_000)).toBe(1_000);
  });
});

describe("createStdinReadyGate", () => {
  it("resolves wait after signalReady", async () => {
    const gate = createStdinReadyGate();
    const pending = gate.wait(1_000);
    gate.signalReady();
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects wait when ready is not signaled within timeout", async () => {
    vi.useFakeTimers();
    try {
      const gate = createStdinReadyGate();
      let rejected: unknown;
      const pending = gate.wait(100).then(
        () => {
          throw new Error("expected timeout rejection");
        },
        (error: unknown) => {
          rejected = error;
        },
      );
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(rejected).toBeInstanceOf(CWSandboxTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects wait with the failure signaled before ready", async () => {
    const gate = createStdinReadyGate();
    const pending = gate.wait(1_000);
    gate.signalFailed(new Error("boom"));
    await expect(pending).rejects.toThrow("boom");
  });
});
