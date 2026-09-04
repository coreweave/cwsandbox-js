// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxNotFoundError,
  CWSandboxValidationError,
  DEFAULT_GRACEFUL_SHUTDOWN_SECONDS,
  type WaitOptions,
} from "./index.js";
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
      gracefulShutdownSeconds: DEFAULT_GRACEFUL_SHUTDOWN_SECONDS,
      sandboxId: "sandbox-for-echo",
    });
  });

  it("defaults stop grace to 10 seconds", async () => {
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

    await sandbox.stop();

    expect(stopRequest).toEqual({
      gracefulShutdownSeconds: 10,
      sandboxId: "sandbox-for-echo",
    });
  });

  it("forwards explicit zero stop grace", async () => {
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

    await sandbox.stop({ gracefulShutdownSeconds: 0 });

    expect(stopRequest).toEqual({
      gracefulShutdownSeconds: 0,
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
      dataPlaneMode: "auto",
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
          exposedPorts: [{ name: "http", port: 8000, protocol: "tcp" }],
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
    expect(sandbox.exposedPorts).toEqual([{ name: "http", port: 8000, protocol: "tcp" }]);
    expect(sandbox.resourceRequests).toEqual({ cpu: "1", memory: "1Gi" });
    expect(sandbox.resourceLimits).toEqual({ cpu: "4", memory: "8Gi" });
    expect(sandbox.dnsEgressNames).toBeUndefined();
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
    expect(sandbox.serviceUrls).toBeUndefined();
    expect(sandbox.statusReason).toBe("ready");
  });

  it("clears serviceUrls when inspect omits them and retains exposedPorts", async () => {
    const ports = [{ name: "http", port: 8000, protocol: "tcp" as const }];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: ports,
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceUrls: [{ name: "http", port: 8000, url: "https://sandbox.example.com" }],
          status: "running",
        };
      },
      async get(request) {
        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    expect(sandbox.serviceUrls).toEqual([
      { name: "http", port: 8000, url: "https://sandbox.example.com" },
    ]);
    expect(sandbox.exposedPorts).toEqual(ports);

    const info = await sandbox.inspect();

    expect(info.serviceUrls).toBeUndefined();
    expect(info.exposedPorts).toEqual(ports);
    expect(sandbox.serviceUrls).toBeUndefined();
    expect(sandbox.exposedPorts).toEqual(ports);
    expect(sandbox.status).toBe("completed");
  });

  it("retains exposedPorts when inspect returns an empty list", async () => {
    const ports = [{ name: "http", port: 8000, protocol: "tcp" as const }];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: ports,
          sandboxId: `sandbox-for-${request.command[0]}`,
          status: "running",
        };
      },
      async get(request) {
        return {
          exposedPorts: [],
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const info = await sandbox.inspect();

    expect(info.exposedPorts).toEqual(ports);
    expect(sandbox.exposedPorts).toEqual(ports);
  });

  it("replaces exposedPorts when inspect returns a nonempty list", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: [{ name: "http", port: 8000, protocol: "tcp" }],
          sandboxId: `sandbox-for-${request.command[0]}`,
          status: "running",
        };
      },
      async get(request) {
        return {
          exposedPorts: [{ name: "metrics", port: 9090, protocol: "tcp" }],
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const info = await sandbox.inspect();

    expect(info.exposedPorts).toEqual([{ name: "metrics", port: 9090, protocol: "tcp" }]);
    expect(sandbox.exposedPorts).toEqual([{ name: "metrics", port: 9090, protocol: "tcp" }]);
  });

  it("replaces serviceEndpoints on inspect and clears them when omitted", async () => {
    const created = {
      auth: "open" as const,
      kind: "https" as const,
      name: "http",
      port: 8000,
      requestTimeoutSeconds: 120,
      url: "https://sandbox.example.com",
    };
    const refreshed = {
      ...created,
      requestTimeoutSeconds: 60,
      url: "",
    };
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceEndpoints: [created],
          status: "running",
        };
      },
      async get(request) {
        return {
          sandboxId: request.sandboxId,
          serviceEndpoints: [refreshed],
          status: "completed",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    expect(sandbox.serviceEndpoints).toEqual([created]);

    const info = await sandbox.inspect();
    expect(info.serviceEndpoints).toEqual([refreshed]);
    expect(sandbox.serviceEndpoints).toEqual([refreshed]);

    const clearing: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceEndpoints: [created],
          status: "running",
        };
      },
      async get(request) {
        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };
    const clearingSandbox = await createClient(clearing).run(["echo"], { waitUntilRunning: false });
    const cleared = await clearingSandbox.inspect();
    expect(cleared.serviceEndpoints).toBeUndefined();
    expect(clearingSandbox.serviceEndpoints).toBeUndefined();
  });

  it("exposes dnsEgressNames from start and inspect", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          dnsEgressNames: ["pypi.org", "*.pypi.org"],
          sandboxId: `sandbox-for-${request.command[0]}`,
          status: "running",
        };
      },
      async get(request) {
        return {
          dnsEgressNames: ["pypi.org"],
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    expect(sandbox.dnsEgressNames).toEqual(["pypi.org", "*.pypi.org"]);
    expect(sandbox.dnsEgressNames).not.toBe(sandbox.dnsEgressNames);

    const info = await sandbox.inspect();
    expect(info.dnsEgressNames).toEqual(["pypi.org"]);
    expect(sandbox.dnsEgressNames).toEqual(["pypi.org"]);
  });

  it("clears last echoed dnsEgressNames when inspect omits them", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          dnsEgressNames: ["pypi.org"],
          sandboxId: `sandbox-for-${request.command[0]}`,
          status: "running",
        };
      },
      async get(request) {
        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const info = await sandbox.inspect();

    expect(info.dnsEgressNames).toBeUndefined();
    expect(sandbox.dnsEgressNames).toBeUndefined();
    expect(sandbox.status).toBe("completed");
  });

  it("clears last echoed dnsEgressNames when inspect returns an empty list", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          dnsEgressNames: ["pypi.org"],
          sandboxId: `sandbox-for-${request.command[0]}`,
          status: "running",
        };
      },
      async get(request) {
        return {
          dnsEgressNames: [],
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const info = await sandbox.inspect();

    expect(info.dnsEgressNames).toEqual([]);
    expect(sandbox.dnsEgressNames).toBeUndefined();
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
          exposedPorts: [{ name: "http", port: 8000, protocol: "tcp" }],
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
      exposedPorts: [{ name: "http", port: 8000, protocol: "tcp" }],
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
    expect(sandbox.exposedPorts).toEqual([{ name: "http", port: 8000, protocol: "tcp" }]);
  });

  it("retains TLS addresses when a live Get omits them", async () => {
    const address = {
      address: "8443-tls-id.example:443",
      kind: "tls_passthrough" as const,
      name: "tls",
      port: 8443,
    };
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceAddresses: [address],
          status: "creating",
        };
      },
      async get(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    expect(sandbox.serviceAddresses).toEqual([address]);

    const info = await sandbox.inspect();
    expect(info.serviceAddresses).toEqual([address]);
    expect(sandbox.serviceAddresses).toEqual([address]);
    expect(sandbox.status).toBe("running");
  });

  it("handle retains TLS address when inspect Get is the mapped PREPARING SDK shape (creating, ports present, address omitted)", async () => {
    const address = {
      address: "8443-tls-id.example:443",
      kind: "tls_passthrough" as const,
      name: "tls",
      port: 8443,
    };
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceAddresses: [address],
          status: "creating",
        };
      },
      async get(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443 }],
          sandboxId: request.sandboxId,
          status: "creating",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const info = await sandbox.inspect();

    expect(info.serviceAddresses).toEqual([address]);
    expect(sandbox.serviceAddresses).toEqual([address]);
    expect(sandbox.status).toBe("creating");
  });

  it("handle clears TLS address when mapped PREPARING inspect Get has no service rows", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceAddresses: [
            {
              address: "8443-tls-id.example:443",
              kind: "tls_passthrough",
              name: "tls",
              port: 8443,
            },
          ],
          status: "creating",
        };
      },
      async get(request) {
        return {
          sandboxId: request.sandboxId,
          status: "creating",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const info = await sandbox.inspect();

    expect(info.serviceAddresses).toBeUndefined();
    expect(sandbox.serviceAddresses).toBeUndefined();
  });

  it("clears TLS addresses when inspect reaches a terminal status", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceAddresses: [
            {
              address: "8443-tls-id.example:443",
              kind: "tls_passthrough",
              name: "tls",
              port: 8443,
            },
          ],
          status: "running",
        };
      },
      async get(request) {
        return {
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const info = await sandbox.inspect();

    expect(info.serviceAddresses).toBeUndefined();
    expect(sandbox.serviceAddresses).toBeUndefined();
  });

  it("clears TLS addresses when inspect reaches paused", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceAddresses: [
            {
              address: "8443-tls-id.example:443",
              kind: "tls_passthrough",
              name: "tls",
              port: 8443,
            },
          ],
          status: "running",
        };
      },
      async get(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: request.sandboxId,
          status: "paused",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const info = await sandbox.inspect();

    expect(info.serviceAddresses).toBeUndefined();
    expect(sandbox.serviceAddresses).toBeUndefined();
    expect(sandbox.status).toBe("paused");
  });

  it("clears TLS addresses when inspect reaches unspecified", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceAddresses: [
            {
              address: "8443-tls-id.example:443",
              kind: "tls_passthrough",
              name: "tls",
              port: 8443,
            },
          ],
          status: "running",
        };
      },
      async get(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: request.sandboxId,
          status: "unspecified",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const info = await sandbox.inspect();

    expect(info.serviceAddresses).toBeUndefined();
    expect(sandbox.serviceAddresses).toBeUndefined();
    expect(sandbox.status).toBe("unspecified");
  });

  it("drops a cached TLS address when the service row is gone", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceAddresses: [
            {
              address: "8443-tls-id.example:443",
              kind: "tls_passthrough",
              name: "tls",
              port: 8443,
            },
          ],
          status: "running",
        };
      },
      async get(request) {
        return {
          exposedPorts: [{ name: "http", port: 8000, protocol: "tcp" }],
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    await sandbox.inspect();
    expect(sandbox.serviceAddresses).toBeUndefined();
  });

  it("does not inherit another handle TLS cache on fromId", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: `sandbox-for-${request.command[0]}`,
          serviceAddresses: [
            {
              address: "8443-tls-id.example:443",
              kind: "tls_passthrough",
              name: "tls",
              port: 8443,
            },
          ],
          status: "running",
        };
      },
      async get(request) {
        return {
          exposedPorts: [{ name: "tls", port: 8443, protocol: "tcp" }],
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };

    const client = createClient(transport);
    const created = await client.run(["echo"], { waitUntilRunning: false });
    expect(created.serviceAddresses).toHaveLength(1);

    const fetched = await client.fromId(created.sandboxId);
    expect(fetched.serviceAddresses).toBeUndefined();
  });

  it("caches inspect exitCode including zero", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        return {
          sandboxId: `sandbox-for-${request.command[0]}`,
          status: "running",
        };
      },
      async get(request) {
        return {
          exitCode: 0,
          sandboxId: request.sandboxId,
          status: "completed",
        };
      },
    };

    const sandbox = await createClient(transport).run(["echo"], { waitUntilRunning: false });
    const info = await sandbox.inspect();

    expect(info.exitCode).toBe(0);
    expect(sandbox.exitCode).toBe(0);
    expect(sandbox.status).toBe("completed");
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
