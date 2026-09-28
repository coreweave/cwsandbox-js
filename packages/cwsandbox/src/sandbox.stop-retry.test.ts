// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxNotFoundError, type SandboxStatus } from "./index.js";
import { createClient, createFakeTransport } from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";
import type { GetSandboxRequest } from "./transport/types.js";

/** Records every transport.get request; answers with the scripted statuses. */
function recordingTransport(
  statuses: SandboxStatus[],
  overrides: Partial<SandboxTransport> = {},
): { readonly gets: GetSandboxRequest[]; readonly transport: SandboxTransport } {
  const gets: GetSandboxRequest[] = [];
  const transport: SandboxTransport = {
    ...createFakeTransport(),
    async get(request) {
      gets.push(request);
      return {
        runnerId: `runner-${gets.length}`,
        sandboxId: request.sandboxId,
        status: statuses.shift() ?? "completed",
      };
    },
    async stop() {
      return undefined;
    },
    ...overrides,
  };
  return { gets, transport };
}

async function startedSandbox(transport: SandboxTransport) {
  return createClient(transport).run(["echo", "hi"], { waitUntilRunning: false });
}

describe("stop() hinted-retry wiring", () => {
  it("marks only the preflight Get for retry, without the waiter's timeout or signal", async () => {
    const { gets, transport } = recordingTransport(["running", "completed"]);
    const sandbox = await startedSandbox(transport);

    await sandbox.stop({ signal: new AbortController().signal, timeoutMs: 60_000 });

    expect(gets[0]).toEqual({ retryHintedUnavailable: true, sandboxId: sandbox.sandboxId });
    // Terminal polling after the stop RPC is unchanged and carries no marker.
    expect(gets.slice(1).every((request) => request.retryHintedUnavailable === undefined)).toBe(
      true,
    );
  });

  it("refreshes metadata from the preflight before returning early", async () => {
    const { gets, transport } = recordingTransport(["completed"]);
    let stopCalls = 0;
    const sandbox = await startedSandbox({
      ...transport,
      async stop() {
        stopCalls += 1;
      },
    });

    await sandbox.stop();

    expect(gets).toHaveLength(1);
    expect(stopCalls).toBe(0);
    expect(sandbox.status).toBe("completed");
    expect(sandbox.runnerId).toBe("runner-1");
  });

  it("treats an already-gone stop as stopped and skips terminal polling", async () => {
    const { gets, transport } = recordingTransport(["running"], {
      async stop() {
        return { alreadyGone: true };
      },
    });
    const sandbox = await startedSandbox(transport);

    await expect(sandbox.stop()).resolves.toBeUndefined();

    expect(gets).toHaveLength(1);
    expect(sandbox.status).toBe("terminated");
  });

  it("clears running-only service fields when a stop finds the sandbox gone", async () => {
    const tls = {
      address: "8443-tls-id.example:443",
      kind: "tls_passthrough" as const,
      name: "tls",
      port: 8443,
    };
    const { transport } = recordingTransport([], {
      async get(request) {
        return { serviceAddresses: [tls], sandboxId: request.sandboxId, status: "running" };
      },
      async stop() {
        return { alreadyGone: true };
      },
    });
    const sandbox = await startedSandbox(transport);
    await sandbox.inspect();
    expect(sandbox.serviceAddresses).toEqual([tls]);

    await sandbox.stop();

    expect(sandbox.status).toBe("terminated");
    expect(sandbox.serviceAddresses).toBeUndefined();
  });

  it("isolates a waiter that aborts while the status check is pending", async () => {
    let releaseGet: () => void = () => undefined;
    let stopCalls = 0;
    const { transport } = recordingTransport([], {
      async get(request) {
        if (stopCalls === 0) {
          await new Promise<void>((resolve) => {
            releaseGet = resolve;
          });
          return { sandboxId: request.sandboxId, status: "running" };
        }
        return { sandboxId: request.sandboxId, status: "completed" };
      },
      async stop() {
        stopCalls += 1;
      },
    });
    const sandbox = await startedSandbox(transport);
    const controller = new AbortController();

    const aborted = sandbox.stop({ signal: controller.signal });
    const patient = sandbox.stop();
    controller.abort(new Error("gave up"));
    await expect(aborted).rejects.toThrow("gave up");
    releaseGet();

    await expect(patient).resolves.toBeUndefined();
    expect(stopCalls).toBe(1);
  });

  it("applies missingOk per waiter when the status check finds the sandbox gone", async () => {
    let stopCalls = 0;
    const { transport } = recordingTransport([], {
      async get() {
        throw new CWSandboxNotFoundError("gone");
      },
      async stop() {
        stopCalls += 1;
      },
    });
    const sandbox = await startedSandbox(transport);

    const tolerant = sandbox.stop({ missingOk: true });
    const strict = sandbox.stop();

    await expect(tolerant).resolves.toBeUndefined();
    await expect(strict).rejects.toBeInstanceOf(CWSandboxNotFoundError);
    expect(stopCalls).toBe(0);
  });

  it("still polls to a terminal status after an ordinary stop", async () => {
    const { gets, transport } = recordingTransport(["running", "terminating", "completed"]);
    const sandbox = await startedSandbox(transport);

    await sandbox.stop();

    expect(gets.length).toBeGreaterThan(1);
    expect(sandbox.status).toBe("completed");
  });
});

describe("public Get paths never request the hinted retry", () => {
  it("inspect(), getStatus() and client.get() drop unknown option fields", async () => {
    const { gets, transport } = recordingTransport(["running", "running", "running"]);
    const client = createClient(transport);
    const sandbox = await client.run(["echo", "hi"], { waitUntilRunning: false });
    const widened = { retryHintedUnavailable: true, timeoutMs: 1_000 } as { timeoutMs: number };

    await sandbox.inspect(widened);
    await sandbox.getStatus(widened);
    await client.get(sandbox.sandboxId, widened);

    expect(gets).toEqual([
      { sandboxId: sandbox.sandboxId, timeoutMs: 1_000 },
      { sandboxId: sandbox.sandboxId, timeoutMs: 1_000 },
      { sandboxId: sandbox.sandboxId, timeoutMs: 1_000 },
    ]);
  });

  it("wait() polling requests carry no marker", async () => {
    const { gets, transport } = recordingTransport(["pending", "running"]);
    const sandbox = await startedSandbox(transport);

    await sandbox.wait();

    expect(gets.length).toBeGreaterThan(0);
    expect(gets.every((request) => request.retryHintedUnavailable === undefined)).toBe(true);
  });
});
