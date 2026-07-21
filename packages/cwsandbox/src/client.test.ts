// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxNotFoundError,
  CWSandboxValidationError,
  DEFAULT_KEEP_ALIVE_COMMAND,
  Sandbox,
  type ResourceOptions,
  type SandboxRunOptions,
  type SandboxTransport,
} from "./index.js";
import { createClient, createFakeTransport, createTrackingTransport } from "./test/helpers.js";

describe("SandboxClient", () => {
  describe("lifecycle", () => {
    it("starts a sandbox through the configured transport", async () => {
      const client = createClient();
      const command: string[] = ["echo", "hello"];

      const sandbox = await client.run(command);

      expect(sandbox).toBeInstanceOf(Sandbox);
      expect(sandbox.sandboxId).toBe("sandbox-for-echo");
    });

    it("creates a long-lived sandbox with the default keep-alive command", async () => {
      let startRequest: Parameters<SandboxTransport["start"]>[0] | undefined;
      const statuses = ["creating", "running"] as const;
      let getCalls = 0;
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async start(request) {
          startRequest = request;
          return {
            sandboxId: "sandbox-for-keepalive",
            status: "creating",
          };
        },
        async get(request) {
          const status = statuses[getCalls] ?? "running";
          getCalls += 1;
          return {
            sandboxId: request.sandboxId,
            status,
          };
        },
      };

      const sandbox = await createClient(transport).create();

      expect(sandbox).toBeInstanceOf(Sandbox);
      expect(sandbox.sandboxId).toBe("sandbox-for-keepalive");
      expect(startRequest).toMatchObject({
        command: DEFAULT_KEEP_ALIVE_COMMAND,
      });
      expect(getCalls).toBe(2);
    });

    it("waits for run sandboxes to reach running before resolving by default", async () => {
      const statuses = ["creating", "running"] as const;
      let getCalls = 0;
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async get(request) {
          const status = statuses[getCalls] ?? "running";
          getCalls += 1;
          return {
            sandboxId: request.sandboxId,
            status,
          };
        },
      };

      await createClient(transport).run(["echo", "hello"]);

      expect(getCalls).toBe(2);
    });

    it("can return after start acceptance when waitUntilRunning is false", async () => {
      let getCalls = 0;
      let startRequest: Parameters<SandboxTransport["start"]>[0] | undefined;
      const transport: SandboxTransport = {
        ...createFakeTransport(["creating"]),
        async start(request) {
          startRequest = request;
          return {
            sandboxId: "sandbox-for-echo",
            status: "creating",
          };
        },
        async get(request) {
          getCalls += 1;
          return createFakeTransport().get(request);
        },
      };

      const sandbox = await createClient(transport).run(["echo", "hello"], {
        tags: ["readiness-test"],
        waitUntilRunning: false,
      });

      expect(sandbox.sandboxId).toBe("sandbox-for-echo");
      expect(getCalls).toBe(0);
      expect(startRequest).toEqual({
        command: ["echo", "hello"],
        tags: ["readiness-test"],
      });
    });

    it("reconnects to an existing sandbox by id", async () => {
      let getRequest: Parameters<SandboxTransport["get"]>[0] | undefined;
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async get(request) {
          getRequest = request;
          return {
            runnerId: "runner-id",
            sandboxId: request.sandboxId,
            status: "running",
          };
        },
      };

      const sandbox = await createClient(transport).fromId("sandbox-123", { timeoutMs: 1234 });

      expect(sandbox).toBeInstanceOf(Sandbox);
      expect(sandbox.sandboxId).toBe("sandbox-123");
      expect(sandbox.runnerId).toBe("runner-id");
      expect(getRequest).toEqual({
        sandboxId: "sandbox-123",
        timeoutMs: 1234,
      });
    });

    it("gets fresh sandbox metadata by id", async () => {
      const startedAt = new Date("2026-06-24T15:00:00.000Z");
      let getRequest: Parameters<SandboxTransport["get"]>[0] | undefined;
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async get(request) {
          getRequest = request;
          return {
            runnerId: "runner-id",
            sandboxId: request.sandboxId,
            serviceAddress: "sandbox.example.com",
            startedAt,
            status: "running",
          };
        },
      };

      const result = await createClient(transport).get("sandbox-123", { timeoutMs: 1234 });

      expect(result).toEqual({
        runnerId: "runner-id",
        sandboxId: "sandbox-123",
        serviceAddress: "sandbox.example.com",
        startedAt,
        status: "running",
      });
      expect(getRequest).toEqual({
        sandboxId: "sandbox-123",
        timeoutMs: 1234,
      });
    });

    it("propagates not-found errors from get", async () => {
      const error = new CWSandboxNotFoundError("Sandbox not found.");
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async get() {
          throw error;
        },
      };

      await expect(createClient(transport).get("missing-sandbox")).rejects.toBe(error);
    });

    it("lists sandboxes through the configured transport", async () => {
      let listRequest: Parameters<SandboxTransport["list"]>[0] | undefined;
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async list(options) {
          listRequest = options;
          return {
            nextPageToken: "next-page",
            sandboxes: [
              {
                serviceAddress: "sandbox.example.com",
                sandboxId: "sandbox-123",
                status: "running",
              },
            ],
          };
        },
      };

      const result = await createClient(transport).list({
        includeStopped: true,
        pageSize: 10,
        pageToken: "page-1",
        status: "running",
        tags: ["tag-a"],
        timeoutMs: 1234,
      });

      expect(result).toEqual({
        nextPageToken: "next-page",
        sandboxes: [
          {
            serviceAddress: "sandbox.example.com",
            sandboxId: "sandbox-123",
            status: "running",
          },
        ],
      });
      expect(listRequest).toEqual({
        includeStopped: true,
        pageSize: 10,
        pageToken: "page-1",
        status: "running",
        tags: ["tag-a"],
        timeoutMs: 1234,
      });
    });

    it("deletes sandboxes through the configured transport", async () => {
      let deleteRequest: Parameters<SandboxTransport["delete"]>[0] | undefined;
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async delete(request) {
          deleteRequest = request;
        },
      };

      await createClient(transport).delete("sandbox-123", { timeoutMs: 1234 });

      expect(deleteRequest).toEqual({
        sandboxId: "sandbox-123",
        timeoutMs: 1234,
      });
    });

    it("treats missing sandboxes as already deleted", async () => {
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async delete(request) {
          throw new CWSandboxNotFoundError(`Sandbox '${request.sandboxId}' not found.`);
        },
      };

      await expect(createClient(transport).delete("missing-sandbox")).resolves.toBeUndefined();
    });

    it("propagates non-not-found delete errors", async () => {
      const error = new Error("delete failed");
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async delete() {
          throw error;
        },
      };

      await expect(createClient(transport).delete("sandbox-123")).rejects.toBe(error);
    });
  });

  describe("validation", () => {
    it("throws a typed validation error for invalid list page sizes", async () => {
      const client = createClient();

      await expect(client.list({ pageSize: -1 })).rejects.toThrow(CWSandboxValidationError);
      await expect(client.list({ pageSize: 1.5 })).rejects.toThrow(CWSandboxValidationError);
      await expect(client.list({ pageSize: Number.NaN })).rejects.toThrow(CWSandboxValidationError);
    });

    it("throws a typed validation error for empty run commands", async () => {
      const client = createClient();

      await expect(client.run([])).rejects.toThrow(CWSandboxValidationError);
    });

    it("throws a typed validation error for invalid mounted file paths", async () => {
      const client = createClient();

      await expect(
        client.run(["python"], {
          mountedFiles: [{ content: "print('hello')", path: "" }],
        }),
      ).rejects.toThrow(CWSandboxValidationError);
      await expect(
        client.run(["python"], {
          mountedFiles: [{ content: "print('hello')", path: "workspace/main.py" }],
        }),
      ).rejects.toThrow(CWSandboxValidationError);
    });

    it("throws a typed validation error for duplicate mounted file paths", async () => {
      const client = createClient();

      await expect(
        client.run(["python"], {
          mountedFiles: [
            { content: "one", path: "/workspace/main.py" },
            { content: "two", path: "/workspace/main.py" },
          ],
        }),
      ).rejects.toThrow(CWSandboxValidationError);
    });

    it("throws a typed validation error for invalid resource values", async () => {
      const client = createClient();

      await expect(client.run(["python"], { resources: {} })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { resources: { cpu: "" } })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { resources: { memory: "" } })).rejects.toThrow(
        CWSandboxValidationError,
      );
    });

    it("throws a typed validation error for invalid advanced resources", async () => {
      const client = createClient();
      const missingLimits = {
        requests: { cpu: "1" },
      } as unknown as ResourceOptions;
      const mixedShape = {
        cpu: "1",
        limits: { cpu: "2" },
        requests: { cpu: "1" },
      } as unknown as ResourceOptions;

      await expect(
        client.run(["python"], {
          resources: missingLimits,
        }),
      ).rejects.toThrow(CWSandboxValidationError);
      await expect(
        client.run(["python"], {
          resources: mixedShape,
        }),
      ).rejects.toThrow(CWSandboxValidationError);
    });

    it("throws a typed validation error for invalid selector values", async () => {
      const client = createClient();

      await expect(client.run(["python"], { profileNames: [""] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { profileIds: ["profile", "profile"] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { runnerIds: ["runner", "runner"] })).rejects.toThrow(
        CWSandboxValidationError,
      );
    });

    it("throws a typed validation error for invalid tag values", async () => {
      const client = createClient();
      const tooLongTag = "a".repeat(60);

      await expect(client.run(["python"], { tags: [""] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { tags: ["tag", "tag"] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { tags: ["tag:invalid"] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { tags: ["invalid-"] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { tags: [tooLongTag] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.list({ tags: [""] })).rejects.toThrow(CWSandboxValidationError);
      await expect(client.list({ tags: ["tag", "tag"] })).rejects.toThrow(CWSandboxValidationError);
      await expect(client.list({ tags: ["tag:invalid"] })).rejects.toThrow(
        CWSandboxValidationError,
      );
    });

    it("throws a typed validation error for invalid annotations", async () => {
      const client = createClient();
      const tooManyAnnotations = Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [`key-${index}`, "value"]),
      );
      const nullAnnotations = { annotations: null } as unknown as SandboxRunOptions;
      const arrayAnnotations = { annotations: ["value"] } as unknown as SandboxRunOptions;
      const nonStringAnnotation = {
        annotations: { key: 123 },
      } as unknown as SandboxRunOptions;

      await expect(client.run(["python"], { annotations: { "": "value" } })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { annotations: { key: "" } })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { annotations: tooManyAnnotations })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], nullAnnotations)).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], arrayAnnotations)).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], nonStringAnnotation)).rejects.toThrow(
        CWSandboxValidationError,
      );
    });

    it("throws a typed validation error for invalid secrets", async () => {
      const client = createClient();

      await expect(
        client.run(["python"], { secrets: [{ store: "", name: "HF_TOKEN" }] }),
      ).rejects.toThrow(CWSandboxValidationError);
      await expect(
        client.run(["python"], {
          environmentVariables: { HF_TOKEN: "plaintext" },
          secrets: [{ store: "wandb-team-secrets", name: "HF_TOKEN" }],
        }),
      ).rejects.toThrow(CWSandboxValidationError);
      await expect(
        client.run(["python"], {
          secrets: [
            { store: "wandb-team-secrets", name: "HF_TOKEN" },
            { envVar: "HF_TOKEN", name: "OTHER", store: "other-store" },
          ],
        }),
      ).rejects.toThrow(CWSandboxValidationError);
    });

    it("throws a typed validation error for invalid network ports", async () => {
      const client = createClient();

      await expect(client.run(["python"], { ports: [0] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { ports: [65536] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { ports: [1.5] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { ports: [8000, 8000] })).rejects.toThrow(
        CWSandboxValidationError,
      );
    });

    it("throws a typed validation error for invalid network strings", async () => {
      const client = createClient();

      await expect(client.run(["python"], { ports: [{ name: "", port: 8000 }] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(
        client.run(["python"], { ports: [{ port: 8000, protocol: "" }] }),
      ).rejects.toThrow(CWSandboxValidationError);
      await expect(client.run(["python"], { network: { ingressMode: "" } })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { network: { egressMode: "" } })).rejects.toThrow(
        CWSandboxValidationError,
      );
    });

    it("throws a typed validation error for undeclared exposed ports", async () => {
      const client = createClient();

      await expect(
        client.run(["python"], {
          network: { exposedPorts: [9000] },
          ports: [8000],
        }),
      ).rejects.toThrow(CWSandboxValidationError);
    });

    it("throws a typed validation error for invalid run timeouts", async () => {
      const client = createClient();

      await expect(client.run(["echo", "hello"], { timeoutMs: -1 })).rejects.toThrow(
        CWSandboxValidationError,
      );
    });

    it("throws a typed validation error for invalid max lifetime values", async () => {
      const client = createClient();

      await expect(
        client.run(["echo", "hello"], { maxLifetimeSeconds: Number.POSITIVE_INFINITY }),
      ).rejects.toThrow(CWSandboxValidationError);
    });

    it("accepts boolean waitUntilRunning values and rejects non-booleans", async () => {
      const client = createClient();
      const invalidWaitUntilRunning = {
        waitUntilRunning: "yes",
      } as unknown as SandboxRunOptions;

      await expect(client.create({ waitUntilRunning: true })).resolves.toBeInstanceOf(Sandbox);
      await expect(client.create({ waitUntilRunning: false })).resolves.toBeInstanceOf(Sandbox);
      await expect(client.create(invalidWaitUntilRunning)).rejects.toThrow(
        CWSandboxValidationError,
      );
    });
  });

  describe("withSandbox", () => {
    it("runs callback-first withSandbox with default keep-alive and cleanup", async () => {
      const events: string[] = [];
      const statuses = ["creating", "running"] as const;
      let getCalls = 0;
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async start(request) {
          events.push(`start:${request.command[0]}`);
          return {
            sandboxId: "sandbox-for-keepalive",
            status: "creating",
          };
        },
        async get(request) {
          const status = statuses[getCalls] ?? "running";
          getCalls += 1;
          events.push(`get:${status}`);
          return {
            sandboxId: request.sandboxId,
            status,
          };
        },
        async stop(request) {
          events.push(`stop:${request.sandboxId}`);
        },
      };
      const client = createClient(transport);

      const result = await client.withSandbox(async (sandbox) => {
        events.push("callback");
        expect(sandbox.sandboxId).toBe("sandbox-for-keepalive");
        return "callback-result";
      });

      expect(result).toBe("callback-result");
      expect(events).toEqual([
        "start:/bin/sh",
        "get:creating",
        "get:running",
        "callback",
        "stop:sandbox-for-keepalive",
      ]);
    });

    it("returns the result from withSandbox and stops the sandbox", async () => {
      const { stoppedSandboxIds, transport } = createTrackingTransport();
      const client = createClient(transport);
      const command: string[] = ["echo", "hello"];

      const result = await client.withSandbox(command, async (sandbox) => {
        expect(sandbox.sandboxId).toBe("sandbox-for-echo");
        return "callback-result";
      });

      expect(result).toBe("callback-result");
      expect(stoppedSandboxIds).toEqual(["sandbox-for-echo"]);
    });

    it("can skip readiness waiting in callback-first withSandbox", async () => {
      let getCalls = 0;
      const { stoppedSandboxIds, transport } = createTrackingTransport();
      const client = createClient({
        ...transport,
        async get(request) {
          getCalls += 1;
          return transport.get(request);
        },
      });

      const result = await client.withSandbox(
        (sandbox) => {
          expect(sandbox.sandboxId).toBe("sandbox-for-/bin/sh");
          return "callback-result";
        },
        { waitUntilRunning: false },
      );

      expect(result).toBe("callback-result");
      expect(getCalls).toBe(0);
      expect(stoppedSandboxIds).toEqual(["sandbox-for-/bin/sh"]);
    });

    it("stops the sandbox and preserves callback errors from withSandbox", async () => {
      const { stoppedSandboxIds, transport } = createTrackingTransport();
      const client = createClient(transport);
      const error = new Error("callback failed");

      await expect(
        client.withSandbox(["echo", "hello"], () => {
          throw error;
        }),
      ).rejects.toBe(error);

      expect(stoppedSandboxIds).toEqual(["sandbox-for-echo"]);
    });

    it("rejects with the stop error when withSandbox cleanup fails after callback success", async () => {
      const stopError = new Error("stop failed");
      const client = createClient({
        ...createFakeTransport(),
        async stop() {
          throw stopError;
        },
      });

      await expect(client.withSandbox(["echo", "hello"], () => "callback-result")).rejects.toBe(
        stopError,
      );
    });

    it("preserves callback errors when withSandbox cleanup also fails", async () => {
      const callbackError = new Error("callback failed");
      const stopError = new Error("stop failed");
      const client = createClient({
        ...createFakeTransport(),
        async stop() {
          throw stopError;
        },
      });

      await expect(
        client.withSandbox(["echo", "hello"], () => {
          throw callbackError;
        }),
      ).rejects.toBe(callbackError);
    });

    it("throws a typed validation error for empty withSandbox commands", async () => {
      const client = createClient();

      await expect(client.withSandbox([], () => undefined)).rejects.toThrow(
        CWSandboxValidationError,
      );
    });
  });
});
