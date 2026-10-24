// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  isSnapshotError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
  CWSandboxValidationError,
} from "./errors.js";
import type { FileSystemSnapshotResult } from "./public/sandbox.js";
import type { SandboxRuntime } from "./runtime/context.js";
import { captureFileSystemSnapshot } from "./runtime/snapshot.js";
import { createClient, createFakeSnapshot, createFakeTransport } from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";

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
    const states: FileSystemSnapshotResult["state"][] = ["creating", "ready"];
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot(request) {
        expect(request.sandboxId).toBe("sandbox-for-echo");
        expect(request.requestId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        return createFakeSnapshot("snap-1", { state: "creating" });
      },
      async getFileSystemSnapshot(request) {
        expect(request.snapshotId).toBe("snap-1");
        return createFakeSnapshot("snap-1", {
          objectBucket: "org-fss",
          sizeBytes: 2048,
          sourceSandboxId: "sandbox-for-echo",
          state: states.shift() ?? "ready",
          trigger: "manual",
        });
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.snapshot({ timeoutMs: 5_000 })).resolves.toEqual({
      objectBucket: "org-fss",
      sizeBytes: 2048,
      snapshotId: "snap-1",
      sourceSandboxId: "sandbox-for-echo",
      state: "ready",
      trigger: "manual",
    });
  });

  it("omits scratchVolumeName on create and does not take size from Create", async () => {
    let createRequest: Parameters<SandboxTransport["createFileSystemSnapshot"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot(request) {
        createRequest = request;
        return createFakeSnapshot("snap-create", { sizeBytes: 999, state: "creating" });
      },
      async getFileSystemSnapshot() {
        return createFakeSnapshot("snap-create", { sizeBytes: 12 });
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.snapshot()).resolves.toEqual({
      snapshotId: "snap-create",
      sizeBytes: 12,
      state: "ready",
      trigger: "unspecified",
    });
    expect(createRequest).toMatchObject({
      sandboxId: "sandbox-for-echo",
    });
    expect(createRequest).not.toHaveProperty("scratchVolumeName");
  });

  it("omits scratchVolumeName after a convenience fileSystemSnapshot create", async () => {
    let createRequest: Parameters<SandboxTransport["createFileSystemSnapshot"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot(request) {
        createRequest = request;
        return createFakeSnapshot("snap-fss");
      },
    };
    const sandbox = await createClient(transport).create({
      fileSystemSnapshot: { mountPath: "/workspace" },
      waitUntilRunning: false,
    });

    await expect(sandbox.snapshot()).resolves.toMatchObject({ snapshotId: "snap-fss" });
    expect(createRequest).not.toHaveProperty("scratchVolumeName");
  });

  it("rejects snapshot() before the RPC when this process created multiple scratches", async () => {
    let createCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot() {
        createCalls += 1;
        return createFakeSnapshot("snap-multi");
      },
    };
    const sandbox = await createClient(transport).create({
      waitUntilRunning: false,
      volumes: [
        { mountPath: "/workspace", name: "workspace" },
        { mountPath: "/cache", name: "cache" },
      ],
    });

    await expect(sandbox.snapshot()).rejects.toThrow(
      /snapshot\(\) cannot choose among multiple scratch volumes \(workspace, cache\)/,
    );
    expect(createCalls).toBe(0);
  });

  it("omits scratchVolumeName after fromId", async () => {
    let createRequest: Parameters<SandboxTransport["createFileSystemSnapshot"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot(request) {
        createRequest = request;
        return createFakeSnapshot("snap-from-id");
      },
    };
    const sandbox = await createClient(transport).fromId("existing-sandbox");

    await expect(sandbox.snapshot()).resolves.toMatchObject({ snapshotId: "snap-from-id" });
    expect(createRequest).not.toHaveProperty("scratchVolumeName");
  });

  it("throws when the snapshot reaches FAILED", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot() {
        return createFakeSnapshot("snap-fail", { state: "creating" });
      },
      async getFileSystemSnapshot() {
        return createFakeSnapshot("snap-fail", {
          state: "failed",
          stateReason: "archive exploded",
        });
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

    expect(isSnapshotError(error)).toBe(true);
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
        return createFakeSnapshot("snap-slow", { state: "creating" });
      },
      async getFileSystemSnapshot() {
        return createFakeSnapshot("snap-slow", { state: "creating" });
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
        return createFakeSnapshot("snap-retry", { state: "creating" });
      },
      async getFileSystemSnapshot() {
        getCalls += 1;
        if (getCalls === 1) {
          throw new CWSandboxUnavailableError("get unavailable");
        }
        return createFakeSnapshot("snap-retry", { sizeBytes: 8 });
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.snapshot({ timeoutMs: 5_000 })).resolves.toEqual({
      snapshotId: "snap-retry",
      sizeBytes: 8,
      state: "ready",
      trigger: "unspecified",
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
        return createFakeSnapshot("snap-not-ready", { state: "creating" });
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

  it("poll Gets use the 15s poll RPC timeout, not the archive wait", async () => {
    const getTimeouts: number[] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot() {
        return createFakeSnapshot("snap-poll", { state: "creating" });
      },
      async getFileSystemSnapshot(request) {
        getTimeouts.push(request.timeoutMs ?? -1);
        return createFakeSnapshot("snap-poll");
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await sandbox.snapshot({ timeoutMs: 60_000 });
    expect(getTimeouts[0]).toBe(15_000);
  });
});

describe("snapshot retry options", () => {
  it("extends provisioning retries beyond 30 seconds with one request key", async () => {
    const clock = fakeClock();
    const requests: string[] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot(request) {
        requests.push(request.requestId);
        if (clock.now() < 40_000) {
          throw new CWSandboxUnavailableError("provisioning", { retryDelayMs: 10_000 });
        }
        return createFakeSnapshot("snapshot-test");
      },
    };
    await captureFileSystemSnapshot(
      { sandboxId: "sandbox-test", transport },
      {
        ...clock,
        retryBudgetMs: 60_000,
        requestId: "snapshot-request",
      },
    );
    expect(requests).toEqual(Array.from({ length: 5 }, () => "snapshot-request"));
  });

  it("zero disables retries without shortening the first RPC to 1ms", async () => {
    const timeouts: (number | undefined)[] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot(request) {
        timeouts.push(request.timeoutMs);
        throw new CWSandboxUnavailableError("provisioning");
      },
    };
    const sandbox = await createClient(transport).fromId("sandbox-test");
    await expect(sandbox.snapshot({ retryBudgetMs: 0 })).rejects.toThrow(CWSandboxUnavailableError);
    expect(timeouts).toEqual([15_000]);
  });

  it.each([-1, NaN, Infinity, -Infinity])(
    "rejects invalid retry budget %s",
    async (retryBudgetMs) => {
      const sandbox = await createClient().fromId("sandbox-test");
      await expect(sandbox.snapshot({ retryBudgetMs })).rejects.toThrow(CWSandboxValidationError);
    },
  );

  it("preserves an explicit request ID across separate snapshot calls", async () => {
    const requests: string[] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async createFileSystemSnapshot(request) {
        requests.push(request.requestId);
        if (requests.length === 1) {
          throw new CWSandboxTimeoutError("ambiguous deadline");
        }
        return createFakeSnapshot("snapshot-test");
      },
    };
    const sandbox = await createClient(transport).fromId("sandbox-test");
    await expect(sandbox.snapshot({ requestId: "same-request" })).rejects.toThrow(
      CWSandboxTimeoutError,
    );
    await sandbox.snapshot({ requestId: "same-request" });
    expect(requests).toEqual(["same-request", "same-request"]);
  });
});

it("rejects an empty snapshot idempotency key", async () => {
  const sandbox = await createClient().fromId("sandbox-test");
  await expect(sandbox.snapshot({ requestId: " " })).rejects.toThrow(CWSandboxValidationError);
});

it("caps custom snapshot retries at the archive deadline", async () => {
  const timer = fakeClock();
  let calls = 0;
  const transport: SandboxTransport = {
    ...createFakeTransport(["running"]),
    async createFileSystemSnapshot() {
      calls += 1;
      throw new CWSandboxUnavailableError("provisioning", { retryDelayMs: 10_000 });
    },
  };
  const error: unknown = await captureFileSystemSnapshot(
    { sandboxId: "sandbox-test", transport },
    {
      ...timer,
      retryBudgetMs: 120_000,
      timeoutMs: 1_000,
    },
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CWSandboxTimeoutError);
  expect(isSnapshotError(error)).toBe(true);
  expect(calls).toBe(1);
  expect(timer.now()).toBe(6_000); // Includes the existing 5s observation slack.
});
