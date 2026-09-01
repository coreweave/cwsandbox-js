// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxFailedError,
  CWSandboxNotFoundError,
  CWSandboxResourceExhaustedError,
  CWSandboxTerminatedError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
  CWSandboxValidationError,
  type WaitOptions,
} from "./index.js";
import type { SandboxRuntime } from "./runtime/context.js";
import { waitForSandbox, type WaitForSandboxOptions } from "./runtime/wait.js";
import { createClient, createFakeTransport } from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";

/** Test-only: pass internal initialIntervalMs through public wait(). */
function fastWait(options: WaitForSandboxOptions = {}): WaitOptions {
  return { initialIntervalMs: 1, ...options } as WaitOptions;
}

describe("Sandbox status and wait", () => {
  it("gets the current sandbox status", async () => {
    const sandbox = await createClient(createFakeTransport(["creating"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.getStatus()).resolves.toBe("creating");
  });

  it("forwards getStatus options to the transport", async () => {
    const signal = new AbortController().signal;
    let getRequest: Parameters<SandboxTransport["get"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async get(request) {
        getRequest = request;
        return {
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await sandbox.getStatus({ signal, timeoutMs: 1234 });

    expect(getRequest).toEqual({
      sandboxId: "sandbox-for-echo",
      signal,
      timeoutMs: 1234,
    });
  });

  it("waits until the sandbox is running", async () => {
    const sandbox = await createClient(createFakeTransport(["creating", "running"])).run(
      ["echo", "hello"],
      {
        waitUntilRunning: false,
      },
    );

    await expect(sandbox.wait(fastWait({ timeoutMs: 100 }))).resolves.toBe(sandbox);
  });

  it("retries transient unavailable status checks while waiting", async () => {
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        if (getCalls === 1) {
          throw new CWSandboxUnavailableError("try again");
        }

        return {
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait(fastWait({ timeoutMs: 5_000 }))).resolves.toBe(sandbox);
    expect(getCalls).toBe(2);
  });

  it("retries transient timeout status checks while waiting", async () => {
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        if (getCalls === 1) {
          throw new CWSandboxTimeoutError("deadline");
        }

        return {
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait(fastWait({ timeoutMs: 5_000 }))).resolves.toBe(sandbox);
    expect(getCalls).toBe(2);
  });

  it("retries transient resource-exhausted status checks while waiting", async () => {
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        if (getCalls === 1) {
          throw new CWSandboxResourceExhaustedError("busy");
        }

        return {
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait(fastWait({ timeoutMs: 5_000 }))).resolves.toBe(sandbox);
    expect(getCalls).toBe(2);
  });

  it("passes a poll timeoutMs on wait status Gets", async () => {
    let getRequest: Parameters<SandboxTransport["get"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async get(request) {
        getRequest = request;
        return {
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await sandbox.wait(fastWait({ timeoutMs: 60_000 }));

    expect(getRequest?.timeoutMs).toBeTypeOf("number");
    expect(getRequest?.timeoutMs).toBeGreaterThan(0);
    expect(getRequest?.timeoutMs).toBeLessThanOrEqual(15_000);
  });

  it("waits until the requested target status", async () => {
    const sandbox = await createClient(createFakeTransport(["creating", "completed"])).run(
      ["echo", "hello"],
      {
        waitUntilRunning: false,
      },
    );

    await expect(
      sandbox.wait(fastWait({ targetStatus: "completed", timeoutMs: 100 })),
    ).resolves.toBe(sandbox);
  });

  it("caches PID-1 exitCode after wait reaches completed", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        return {
          exitCode: 67,
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait(fastWait({ targetStatus: "completed", timeoutMs: 100 })),
    ).resolves.toBe(sandbox);
    expect(sandbox.status).toBe("completed");
    expect(sandbox.exitCode).toBe(67);
  });

  it("waits until any terminal status when targetStatus is terminal", async () => {
    const sandbox = await createClient(createFakeTransport(["terminating", "failed"])).run(
      ["echo", "hello"],
      {
        waitUntilRunning: false,
      },
    );

    await expect(
      sandbox.wait(fastWait({ targetStatus: "terminal", timeoutMs: 100 })),
    ).resolves.toBe(sandbox);
    expect(sandbox.status).toBe("failed");
  });

  it("keeps NotFound fatal for observe-only terminal waits", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get() {
        throw new CWSandboxNotFoundError("missing");
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait(fastWait({ targetStatus: "terminal", timeoutMs: 100 })),
    ).rejects.toThrow(CWSandboxNotFoundError);
  });

  it("treats paused as ready for the default running wait", async () => {
    const sandbox = await createClient(createFakeTransport(["paused"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait(fastWait({ timeoutMs: 100 }))).resolves.toBe(sandbox);
    expect(sandbox.status).toBe("paused");
  });

  it("treats polled paused as ready for the default running wait", async () => {
    const sandbox = await createClient(createFakeTransport(["creating", "paused"])).run(
      ["echo", "hello"],
      { waitUntilRunning: false },
    );

    await expect(sandbox.wait(fastWait({ timeoutMs: 100 }))).resolves.toBe(sandbox);
    expect(sandbox.status).toBe("paused");
  });

  it("succeeds when completed during default wait-until-running", async () => {
    const sandbox = await createClient(createFakeTransport(["completed"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait(fastWait({ timeoutMs: 100 }))).resolves.toBe(sandbox);
    expect(sandbox.status).toBe("completed");
  });

  it("throws CWSandboxFailedError when failed during default wait-until-running", async () => {
    const sandbox = await createClient(createFakeTransport(["failed"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait(fastWait({ timeoutMs: 100 }))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CWSandboxFailedError &&
        error.operation === "Wait for sandbox" &&
        error.sandboxId === "sandbox-for-echo",
    );
  });

  it("throws CWSandboxTerminatedError when terminated during default wait-until-running", async () => {
    const sandbox = await createClient(createFakeTransport(["terminated"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait(fastWait({ timeoutMs: 100 }))).rejects.toBeInstanceOf(
      CWSandboxTerminatedError,
    );
  });

  it("drains terminating to completed for default wait-until-running", async () => {
    const sandbox = await createClient(createFakeTransport(["terminating", "completed"])).run(
      ["echo", "hello"],
      { waitUntilRunning: false },
    );

    await expect(sandbox.wait(fastWait({ timeoutMs: 100 }))).resolves.toBe(sandbox);
    expect(sandbox.status).toBe("completed");
  });

  it("drains terminating to failed with CWSandboxFailedError", async () => {
    const sandbox = await createClient(createFakeTransport(["terminating", "failed"])).run(
      ["echo", "hello"],
      { waitUntilRunning: false },
    );

    await expect(sandbox.wait(fastWait({ timeoutMs: 100 }))).rejects.toBeInstanceOf(
      CWSandboxFailedError,
    );
  });

  it("keeps exact match for explicit paused target", async () => {
    const sandbox = await createClient(createFakeTransport(["running", "paused"])).run(
      ["echo", "hello"],
      { waitUntilRunning: false },
    );

    await expect(sandbox.wait(fastWait({ targetStatus: "paused", timeoutMs: 100 }))).resolves.toBe(
      sandbox,
    );
    expect(sandbox.status).toBe("paused");
  });

  it("keeps transport error when a non-running target hits a different terminal", async () => {
    const sandbox = await createClient(createFakeTransport(["failed"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait(fastWait({ targetStatus: "completed", timeoutMs: 100 })),
    ).rejects.toBeInstanceOf(CWSandboxTransportError);
  });

  it("throws a typed timeout error when wait exceeds the timeout", async () => {
    const sandbox = await createClient(createFakeTransport(["creating"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait(fastWait({ timeoutMs: 1 }))).rejects.toThrow(CWSandboxTimeoutError);
  });

  it("throws typed validation errors for invalid wait and status options", async () => {
    const sandbox = await createClient().run(["echo", "hello"], { waitUntilRunning: false });

    await expect(sandbox.wait({ timeoutMs: Number.NaN })).rejects.toThrow(CWSandboxValidationError);
    await expect(sandbox.getStatus({ timeoutMs: Number.NaN })).rejects.toThrow(
      CWSandboxValidationError,
    );
  });

  it("respects abort signals while waiting", async () => {
    const controller = new AbortController();
    const sandbox = await createClient(createFakeTransport(["creating"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });
    const reason = new Error("aborted");

    controller.abort(reason);

    await expect(
      sandbox.wait(fastWait({ signal: controller.signal, timeoutMs: 100 })),
    ).rejects.toBe(reason);
  });

  it("returns immediately with a single Get when already at the target status", async () => {
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async get(request) {
        getCalls += 1;
        return {
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait(fastWait({ timeoutMs: 100 }))).resolves.toBe(sandbox);
    expect(getCalls).toBe(1);
  });

  it("maps wait-deadline exhaustion during UNAVAILABLE retries to Timeout", async () => {
    let nowMs = 1_000;
    const last = new CWSandboxUnavailableError("still down");
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get() {
        throw last;
      },
    };
    const runtime: SandboxRuntime = {
      dataPlaneMode: "auto",
      sandboxId: "sandbox-clamp",
      transport,
    };

    // Smaller than the internal 30s retry budget; wait deadline must win and
    // surface Timeout (Python outer wait_for), not the last transient.
    await expect(
      waitForSandbox(runtime, {
        now: () => nowMs,
        random: () => 0,
        sleep: async (timeoutMs) => {
          nowMs += timeoutMs;
        },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(CWSandboxTimeoutError);
    expect(nowMs).toBeLessThanOrEqual(2_000);
  });

  it("does not let a slow first Get plus retries overrun timeoutMs", async () => {
    let nowMs = 0;
    let getCalls = 0;
    const last = new CWSandboxUnavailableError("still down");
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get({ timeoutMs }) {
        getCalls += 1;
        if (getCalls === 1) {
          // Simulate a wedged Get that consumes the poll RPC cap.
          nowMs += Math.min(timeoutMs ?? 15_000, 15_000);
        }
        throw last;
      },
    };
    const runtime: SandboxRuntime = {
      dataPlaneMode: "auto",
      sandboxId: "sandbox-overrun",
      transport,
    };

    await expect(
      waitForSandbox(runtime, {
        now: () => nowMs,
        random: () => 0,
        sleep: async (timeoutMs) => {
          nowMs += timeoutMs;
        },
        timeoutMs: 20_000,
      }),
    ).rejects.toThrow(CWSandboxTimeoutError);

    expect(nowMs).toBeLessThanOrEqual(20_000);
    // Must not arm a fresh 30s retry burst after the 15s first Get.
    expect(nowMs).toBeLessThan(35_000);
  });

  it("rethrows last transient when retry budget dies with wait time left", async () => {
    let nowMs = 0;
    const last = new CWSandboxUnavailableError("still down");
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get() {
        throw last;
      },
    };
    const runtime: SandboxRuntime = {
      dataPlaneMode: "auto",
      sandboxId: "sandbox-budget",
      transport,
    };

    await expect(
      waitForSandbox(runtime, {
        now: () => nowMs,
        random: () => 0,
        sleep: async (timeoutMs) => {
          nowMs += timeoutMs;
        },
        // Wait far longer than the 30s retry budget.
        timeoutMs: 120_000,
      }),
    ).rejects.toBe(last);

    expect(nowMs).toBeLessThanOrEqual(30_000);
  });

  it("does not grace-repoll when COMPLETED already has exitCode 0", async () => {
    const clock = advancingClock();
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        return {
          exitCode: 0,
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait(
        fastWait({
          now: clock.now,
          sleep: clock.sleep,
          targetStatus: "completed",
          timeoutMs: 60_000,
        }),
      ),
    ).resolves.toBe(sandbox);
    expect(getCalls).toBe(1);
    expect(sandbox.exitCode).toBe(0);
  });

  it("grace-repolls COMPLETED until a late exitCode 0 arrives", async () => {
    const clock = advancingClock();
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        return {
          ...(getCalls === 1 ? {} : { exitCode: 0 }),
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait(
        fastWait({
          now: clock.now,
          sleep: clock.sleep,
          targetStatus: "completed",
          timeoutMs: 60_000,
        }),
      ),
    ).resolves.toBe(sandbox);
    expect(getCalls).toBe(2);
    expect(sandbox.exitCode).toBe(0);
  });

  it("keeps wait successful when COMPLETED never reports exitCode", async () => {
    const clock = advancingClock();
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait(
        fastWait({
          now: clock.now,
          sleep: clock.sleep,
          targetStatus: "completed",
          timeoutMs: 60_000,
        }),
      ),
    ).resolves.toBe(sandbox);
    expect(getCalls).toBe(3);
    expect(sandbox.exitCode).toBeUndefined();
  });

  it("does not grace-repoll FAILED without an exitCode", async () => {
    const clock = advancingClock();
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        return {
          sandboxId: request.sandboxId,
          status: "failed",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait(
        fastWait({
          now: clock.now,
          sleep: clock.sleep,
          targetStatus: "terminal",
          timeoutMs: 60_000,
        }),
      ),
    ).resolves.toBe(sandbox);
    expect(getCalls).toBe(1);
    expect(sandbox.exitCode).toBeUndefined();
  });

  it("skips exitCode grace-repoll on stop-owned waits", async () => {
    const clock = advancingClock();
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };
    const runtime: SandboxRuntime = {
      dataPlaneMode: "auto",
      sandboxId: "sandbox-stop-owned",
      transport,
    };

    await waitForSandbox(runtime, {
      now: clock.now,
      retryNotFoundAfterStop: true,
      sleep: clock.sleep,
      targetStatus: "terminal",
      timeoutMs: 60_000,
    });
    expect(getCalls).toBe(1);
  });

  it("keeps in-hand COMPLETED when a grace Get returns FAILED with a code", async () => {
    const clock = advancingClock();
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        if (getCalls === 1) {
          return {
            sandboxId: request.sandboxId,
            status: "completed",
          };
        }
        return {
          exitCode: 67,
          sandboxId: request.sandboxId,
          status: "failed",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait(
        fastWait({
          now: clock.now,
          sleep: clock.sleep,
          targetStatus: "completed",
          timeoutMs: 60_000,
        }),
      ),
    ).resolves.toBe(sandbox);
    expect(getCalls).toBe(3);
    expect(sandbox.status).toBe("completed");
    expect(sandbox.exitCode).toBeUndefined();
  });

  it("keeps in-hand COMPLETED when a grace Get throws", async () => {
    const clock = advancingClock();
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        if (getCalls > 1) {
          throw new CWSandboxNotFoundError("gone");
        }
        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait(
        fastWait({
          now: clock.now,
          sleep: clock.sleep,
          targetStatus: "completed",
          timeoutMs: 60_000,
        }),
      ),
    ).resolves.toBe(sandbox);
    expect(getCalls).toBe(2);
    expect(sandbox.status).toBe("completed");
    expect(sandbox.exitCode).toBeUndefined();
  });

  it("does not throw timeout when the wait deadline expires during exitCode grace", async () => {
    let nowMs = 0;
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait(
        fastWait({
          now: () => nowMs,
          sleep: async (timeoutMs) => {
            nowMs += timeoutMs;
          },
          targetStatus: "completed",
          timeoutMs: 1_000,
        }),
      ),
    ).resolves.toBe(sandbox);
    expect(getCalls).toBe(1);
    expect(sandbox.status).toBe("completed");
  });

  it("grace-repolls COMPLETED during default wait-until-running", async () => {
    const clock = advancingClock();
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        return {
          ...(getCalls === 1 ? {} : { exitCode: 0 }),
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait(fastWait({ now: clock.now, sleep: clock.sleep, timeoutMs: 60_000 })),
    ).resolves.toBe(sandbox);
    expect(getCalls).toBe(2);
    expect(sandbox.exitCode).toBe(0);
  });
});

function advancingClock(): {
  readonly now: () => number;
  readonly sleep: (timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>;
} {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (timeoutMs) => {
      nowMs += timeoutMs;
    },
  };
}
