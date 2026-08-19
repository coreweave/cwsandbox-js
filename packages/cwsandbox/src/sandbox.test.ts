// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxNotFoundError, CWSandboxValidationError, type WaitOptions } from "./index.js";
import { Sandbox } from "./sandbox.js";
import {
  createClient,
  createFakeTransport,
  createTerminalSession,
  createTrackingTransport,
} from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";

describe("Sandbox", () => {
  it("stops sandboxes through the configured transport", async () => {
    let stoppedSandboxId: string | undefined;
    const base = createFakeTransport();
    const transport: SandboxTransport = {
      ...base,
      async stop(request) {
        stoppedSandboxId = request.sandboxId;
        await base.stop(request);
      },
    };
    const client = createClient(transport);

    const sandbox = await client.run(["echo", "hello"]);
    await sandbox.stop();

    expect(stoppedSandboxId).toBe("sandbox-for-echo");
  });

  it("forwards lifecycle stop options to the transport", async () => {
    let stopRequest: Parameters<SandboxTransport["stop"]>[0] | undefined;
    const base = createFakeTransport();
    const transport: SandboxTransport = {
      ...base,
      async stop(request) {
        stopRequest = request;
        await base.stop(request);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.stop({
      gracefulShutdownSeconds: 5,
    });

    expect(stopRequest).toEqual({
      gracefulShutdownSeconds: 5,
      sandboxId: "sandbox-for-echo",
    });
  });

  it("does not forward per-waiter signal or timeoutMs to the Stop RPC", async () => {
    const signal = new AbortController().signal;
    let stopRequest: Parameters<SandboxTransport["stop"]>[0] | undefined;
    const base = createFakeTransport();
    const transport: SandboxTransport = {
      ...base,
      async stop(request) {
        stopRequest = request;
        await base.stop(request);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.stop({ signal, timeoutMs: 1234 });

    expect(stopRequest).toEqual({
      sandboxId: "sandbox-for-echo",
    });
  });

  it("deletes sandboxes through the configured transport", async () => {
    const signal = new AbortController().signal;
    let deleteRequest: Parameters<SandboxTransport["delete"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async delete(request) {
        deleteRequest = request;
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.delete({ signal, timeoutMs: 1234 });

    expect(deleteRequest).toEqual({
      sandboxId: "sandbox-for-echo",
      signal,
      timeoutMs: 1234,
    });
  });

  it("treats missing sandboxes as already deleted when missingOk is true", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async delete(request) {
        throw new CWSandboxNotFoundError(`Sandbox '${request.sandboxId}' not found.`);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.delete({ missingOk: true })).resolves.toBeUndefined();
  });

  it("raises not-found on sandbox delete when missingOk is false", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async delete(request) {
        throw new CWSandboxNotFoundError(`Sandbox '${request.sandboxId}' not found.`);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.delete()).rejects.toBeInstanceOf(CWSandboxNotFoundError);
  });

  it("propagates non-not-found sandbox delete errors", async () => {
    const error = new Error("delete failed");
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async delete() {
        throw error;
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.delete()).rejects.toBe(error);
  });

  it("starts shell sessions through the configured transport", async () => {
    const signal = new AbortController().signal;
    let shellRequest: Parameters<SandboxTransport["startShell"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startShell(request) {
        shellRequest = request;
        return createTerminalSession(request.command);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    const terminal = await sandbox.shell({
      cols: 80,
      command: ["/bin/sh"],
      rows: 24,
      signal,
      timeoutMs: 1234,
    });

    expect(terminal.command).toEqual(["/bin/sh"]);
    expect(shellRequest).toEqual({
      cols: 80,
      command: ["/bin/sh"],
      rows: 24,
      sandboxId: "sandbox-for-echo",
      signal,
      timeoutMs: 1234,
    });
  });

  it("starts default bash shell sessions", async () => {
    let shellRequest: Parameters<SandboxTransport["startShell"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startShell(request) {
        shellRequest = request;
        return createTerminalSession(request.command);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.shell();

    expect(shellRequest).toMatchObject({
      command: ["/bin/bash"],
      sandboxId: "sandbox-for-echo",
    });
  });

  it("validates shell options", async () => {
    const sandbox = await createClient().run(["echo", "hello"]);

    await expect(sandbox.shell({ command: [] })).rejects.toThrow(CWSandboxValidationError);
    await expect(sandbox.shell({ cols: 0 })).rejects.toThrow(CWSandboxValidationError);
    await expect(sandbox.shell({ rows: 1.5 })).rejects.toThrow(CWSandboxValidationError);
  });

  it("stops the sandbox through async dispose", async () => {
    const { stoppedSandboxIds, transport } = createTrackingTransport();
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox[Symbol.asyncDispose]();

    expect(stoppedSandboxIds).toEqual(["sandbox-for-echo"]);
  });

  it("creates Sandbox instances through the test client", async () => {
    const client = createClient();
    const command: string[] = ["echo", "hello"];

    const sandbox = await client.run(command);

    expect(sandbox).toBeInstanceOf(Sandbox);
    expect(sandbox.sandboxId).toBe("sandbox-for-echo");
  });

  it("exposes cached metadata from the start response", async () => {
    const startedAt = new Date("2026-06-23T15:00:00.000Z");
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: [{ name: "http", port: 8000, protocol: "TCP" }],
          resourceLimits: { cpu: "4", memory: "8Gi" },
          resourceRequests: { cpu: "1", memory: "1Gi" },
          runnerId: "runner-id",
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceUrls: [{ name: "http", port: 8000, url: "https://sandbox.example.com" }],
          startedAt,
          status: "running",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });

    expect(sandbox.status).toBe("running");
    expect(sandbox.startedAt).toEqual(startedAt);
    expect(sandbox.runnerId).toBe("runner-id");
    expect(sandbox.serviceUrls).toEqual([
      { name: "http", port: 8000, url: "https://sandbox.example.com" },
    ]);
    expect(sandbox.exposedPorts).toEqual([{ name: "http", port: 8000, protocol: "TCP" }]);
    expect(sandbox.resourceRequests).toEqual({ cpu: "1", memory: "1Gi" });
    expect(sandbox.resourceLimits).toEqual({ cpu: "4", memory: "8Gi" });
  });

  it("refreshes cached metadata when status is fetched", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceUrls: [{ name: "http", port: 8000, url: "https://sandbox.example.com" }],
          status: "creating",
        };
      },
      async get(request) {
        return {
          runnerGroupId: "runner-group-id",
          sandboxId: request.sandboxId,
          status: "running",
          statusReason: "ready",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const status = await sandbox.getStatus();

    expect(status).toBe("running");
    expect(sandbox.status).toBe("running");
    expect(sandbox.runnerGroupId).toBe("runner-group-id");
    expect(sandbox.serviceUrls).toEqual([
      { name: "http", port: 8000, url: "https://sandbox.example.com" },
    ]);
    expect(sandbox.statusReason).toBe("ready");
  });

  it("inspects fresh metadata and forwards request options", async () => {
    const signal = new AbortController().signal;
    let getRequest: Parameters<SandboxTransport["get"]>[0] | undefined;
    const startedAt = new Date("2026-06-23T15:00:00.000Z");
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          sandboxId: `sandbox-for-${request.command[0]}`,
          status: "creating",
        };
      },
      async get(request) {
        getRequest = request;
        return {
          exposedPorts: [{ name: "http", port: 8000, protocol: "TCP" }],
          runnerId: "runner-id",
          sandboxId: request.sandboxId,
          serviceUrls: [{ name: "http", port: 8000, url: "https://sandbox.example.com" }],
          startedAt,
          status: "running",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const info = await sandbox.inspect({ signal, timeoutMs: 1234 });

    expect(info).toEqual({
      exposedPorts: [{ name: "http", port: 8000, protocol: "TCP" }],
      runnerId: "runner-id",
      sandboxId: "sandbox-for-echo",
      serviceUrls: [{ name: "http", port: 8000, url: "https://sandbox.example.com" }],
      startedAt,
      status: "running",
    });
    expect(getRequest).toEqual({
      sandboxId: "sandbox-for-echo",
      signal,
      timeoutMs: 1234,
    });
    expect(sandbox.status).toBe("running");
    expect(sandbox.serviceUrls).toEqual([
      { name: "http", port: 8000, url: "https://sandbox.example.com" },
    ]);
    expect(sandbox.exposedPorts).toEqual([{ name: "http", port: 8000, protocol: "TCP" }]);
  });

  it("refreshes cached metadata while waiting", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          sandboxId: `sandbox-for-${request.command[0]}`,
          status: "creating",
        };
      },
      async get(request) {
        return {
          runnerId: "runner-id",
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    await sandbox.wait({ initialIntervalMs: 1, timeoutMs: 10 } as WaitOptions);

    expect(sandbox.status).toBe("running");
    expect(sandbox.runnerId).toBe("runner-id");
  });
});
