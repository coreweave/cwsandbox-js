// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it, vi } from "vitest";

import {
  CWSandboxNotFoundError,
  CWSandboxTerminalStateUnavailableError,
  CWSandboxTimeoutError,
  type SandboxStatus,
} from "./index.js";
import { createClient, createFakeTransport } from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";

describe("Sandbox.stop terminal wait", () => {
  it("waits through terminating until a terminal status", async () => {
    const statuses: SandboxStatus[] = ["running", "terminating", "completed"];
    let stopCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        const status = statuses.shift() ?? "completed";
        return {
          sandboxId: request.sandboxId,
          status,
        };
      },
      async stop() {
        stopCalls += 1;
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.stop()).resolves.toBeUndefined();
    expect(stopCalls).toBe(1);
    expect(sandbox.status).toBe("completed");
  });

  it("resolves stop when poll returns unspecified and leaves the handle completed", async () => {
    let stopCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        return {
          sandboxId: request.sandboxId,
          status: "unspecified",
        };
      },
      async stop() {
        stopCalls += 1;
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.stop()).resolves.toBeUndefined();
    expect(stopCalls).toBe(1);
    expect(sandbox.status).toBe("completed");
  });

  it("rejects snapshotOnStop and tells callers to use snapshot()", async () => {
    const sandbox = await createClient().run(["echo", "hello"], { waitUntilRunning: false });

    await expect(sandbox.stop({ snapshotOnStop: true } as never)).rejects.toThrow(
      /use sandbox\.snapshot\(\)/,
    );
  });

  it("resolves when the sandbox ends failed", async () => {
    const statuses: SandboxStatus[] = ["running", "failed"];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        return {
          sandboxId: request.sandboxId,
          status: statuses.shift() ?? "failed",
        };
      },
      async stop() {},
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.stop()).resolves.toBeUndefined();
    expect(sandbox.status).toBe("failed");
  });

  it("skips the Stop RPC when preflight sees terminating", async () => {
    let stopCalls = 0;
    const statuses: SandboxStatus[] = ["terminating", "completed"];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        return {
          sandboxId: request.sandboxId,
          status: statuses.shift() ?? "completed",
        };
      },
      async stop() {
        stopCalls += 1;
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await sandbox.stop();

    expect(stopCalls).toBe(0);
    expect(sandbox.status).toBe("completed");
  });

  it("skips work when preflight sees an already terminal sandbox", async () => {
    let stopCalls = 0;
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(["completed"]),
      async get(request) {
        getCalls += 1;
        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
      async stop() {
        stopCalls += 1;
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await sandbox.stop();

    expect(stopCalls).toBe(0);
    expect(getCalls).toBe(1);
  });

  it("reuses the shared stop promise for a second stop call", async () => {
    let stopCalls = 0;
    const base = createFakeTransport();
    const transport: SandboxTransport = {
      ...base,
      async stop(request) {
        stopCalls += 1;
        await base.stop(request);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.stop();
    await sandbox.stop();

    expect(stopCalls).toBe(1);
  });

  it("rejects only the aborted waiter while shared stop continues", async () => {
    let releaseWait: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    let stopCalls = 0;
    let seenStop = false;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        if (!seenStop) {
          return {
            sandboxId: request.sandboxId,
            status: "running",
          };
        }

        await gate;
        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
      async stop() {
        stopCalls += 1;
        seenStop = true;
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });
    const controller = new AbortController();

    const aborted = sandbox.stop({ signal: controller.signal });
    const kept = sandbox.stop();

    await vi.waitFor(() => {
      expect(stopCalls).toBe(1);
    });
    controller.abort(new Error("caller gave up"));

    await expect(aborted).rejects.toThrow("caller gave up");
    releaseWait?.();
    await expect(kept).resolves.toBeUndefined();
    expect(sandbox.status).toBe("completed");
  });

  it("times out only the waiter that passed timeoutMs", async () => {
    let releaseWait: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    let seenStop = false;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        if (!seenStop) {
          return {
            sandboxId: request.sandboxId,
            status: "running",
          };
        }

        await gate;
        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
      async stop() {
        seenStop = true;
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    const timedOut = sandbox.stop({ timeoutMs: 20 });
    const kept = sandbox.stop();

    await expect(timedOut).rejects.toThrow(CWSandboxTimeoutError);
    releaseWait?.();
    await expect(kept).resolves.toBeUndefined();
  });

  it("retries brief NotFound after stop then reaches terminal", async () => {
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        if (getCalls === 1) {
          return {
            sandboxId: request.sandboxId,
            status: "running",
          };
        }
        if (getCalls === 2) {
          throw new CWSandboxNotFoundError("missing");
        }

        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
      async stop() {},
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await sandbox.stop();

    expect(sandbox.status).toBe("completed");
  });

  it("throws terminal-state unavailable when NotFound persists after stop", async () => {
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        if (getCalls === 1) {
          return {
            sandboxId: request.sandboxId,
            status: "running",
          };
        }

        throw new CWSandboxNotFoundError("missing");
      },
      async stop() {},
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.stop()).rejects.toThrow(CWSandboxTerminalStateUnavailableError);
  }, 10_000);
});
