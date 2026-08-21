// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
  CWSandboxValidationError,
} from "./errors.js";
import type { SandboxRuntime } from "./runtime/context.js";
import { captureFileSystemSnapshot } from "./runtime/snapshot.js";
import { createClient, createFakeTransport } from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";
import type { FileSystemSnapshotRecord } from "./transport/types.js";

function fakeClock(): {
  readonly now: () => number;
  readonly sleep: (timeoutMs: number) => Promise<void>;
} {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (timeoutMs) => {
      nowMs += timeoutMs;
    },
  };
}

describe("sandbox.snapshot", () => {
  it("creates a snapshot, polls until READY, and returns sizeBytes", async () => {
    const states: FileSystemSnapshotRecord["state"][] = ["creating", "ready"];
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot(request) {
        expect(request.sandboxId).toBe("sandbox-for-echo");
        expect(request.requestId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        return { snapshotId: "snap-1", state: "creating" };
      },
      async getFileSystemSnapshot(request) {
        expect(request.snapshotId).toBe("snap-1");
        return {
          snapshotId: "snap-1",
          sizeBytes: 2048,
          state: states.shift() ?? "ready",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.snapshot({ timeoutMs: 5_000 })).resolves.toEqual({
      snapshotId: "snap-1",
      sizeBytes: 2048,
    });
  });

  it("omits scratchVolumeName on create and does not take size from Create", async () => {
    let createRequest: Parameters<SandboxTransport["createFileSystemSnapshot"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot(request) {
        createRequest = request;
        return { snapshotId: "snap-create", sizeBytes: 999, state: "creating" };
      },
      async getFileSystemSnapshot() {
        return { snapshotId: "snap-create", sizeBytes: 12, state: "ready" };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.snapshot()).resolves.toEqual({
      snapshotId: "snap-create",
      sizeBytes: 12,
    });
    expect(createRequest).toMatchObject({
      sandboxId: "sandbox-for-echo",
    });
    expect(createRequest).not.toHaveProperty("scratchVolumeName");
  });

  it("throws when the snapshot reaches FAILED", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot() {
        return { snapshotId: "snap-fail", state: "creating" };
      },
      async getFileSystemSnapshot() {
        return {
          snapshotId: "snap-fail",
          state: "failed",
          stateReason: "archive exploded",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    const error = await sandbox.snapshot().then(
      () => {
        throw new Error("expected snapshot() to fail");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect(error).not.toBeInstanceOf(CWSandboxTimeoutError);
    expect((error as CWSandboxTransportError).message).toContain("snap-fail");
    expect((error as CWSandboxTransportError).message).toContain("archive exploded");
  });

  it("times out while the snapshot stays CREATING", async () => {
    const clock = fakeClock();
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot() {
        return { snapshotId: "snap-slow", state: "creating" };
      },
      async getFileSystemSnapshot() {
        return { snapshotId: "snap-slow", state: "creating" };
      },
    };
    const runtime: SandboxRuntime = {
      sandboxId: "sandbox-for-echo",
      transport,
    };

    await expect(
      captureFileSystemSnapshot(runtime, {
        now: clock.now,
        random: () => 0,
        sleep: clock.sleep,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(CWSandboxTimeoutError);
  });

  it("does not retry Create on DEADLINE_EXCEEDED", async () => {
    let createCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot() {
        createCalls += 1;
        throw new CWSandboxTimeoutError("create deadline");
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.snapshot({ timeoutMs: 5_000 })).rejects.toThrow(CWSandboxTimeoutError);
    expect(createCalls).toBe(1);
  });

  it("retries transient Get failures while polling", async () => {
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot() {
        return { snapshotId: "snap-retry", state: "creating" };
      },
      async getFileSystemSnapshot() {
        getCalls += 1;
        if (getCalls === 1) {
          throw new CWSandboxUnavailableError("get unavailable");
        }
        return { snapshotId: "snap-retry", state: "ready", sizeBytes: 8 };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.snapshot({ timeoutMs: 5_000 })).resolves.toEqual({
      snapshotId: "snap-retry",
      sizeBytes: 8,
    });
    expect(getCalls).toBe(2);
  });

  it("does not keep polling when Get returns a terminal FSS_NOT_READY error", async () => {
    let getCalls = 0;
    const error = new CWSandboxTransportError("not ready", {
      domain: "cwsandbox.com",
      reason: "CWSANDBOX_FSS_NOT_READY",
    });
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot() {
        return { snapshotId: "snap-not-ready", state: "creating" };
      },
      async getFileSystemSnapshot() {
        getCalls += 1;
        throw error;
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.snapshot({ timeoutMs: 5_000 })).rejects.toBe(error);
    expect(getCalls).toBe(1);
  });

  it("rejects invalid snapshot request options", async () => {
    const sandbox = await createClient().run(["echo", "hello"], { waitUntilRunning: false });

    await expect(sandbox.snapshot({ timeoutMs: Number.NaN })).rejects.toThrow(
      CWSandboxValidationError,
    );
  });
});
