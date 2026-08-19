// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it, vi } from "vitest";

import { MAX_LIST_ALL_PAGES } from "./defaults.js";
import {
  CWSandboxNotFoundError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxValidationError,
  DEFAULT_KEEP_ALIVE_COMMAND,
  DEFAULT_LIST_ALL_TIMEOUT_MS,
  type ResourceOptions,
  type SandboxRunOptions,
} from "./index.js";
import { Sandbox } from "./sandbox.js";
import { createClient, createFakeTransport, createTrackingTransport } from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";

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
            startedAt,
            status: "running",
          };
        },
      };

      const result = await createClient(transport).get("sandbox-123", { timeoutMs: 1234 });

      expect(result).toEqual({
        runnerId: "runner-id",
        sandboxId: "sandbox-123",
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
                sandboxId: "sandbox-123",
                status: "running",
              },
            ],
          };
        },
      };

      const result = await createClient(transport).list({
        pageSize: 10,
        pageToken: "page-1",
        showTerminated: true,
        status: "running",
        tags: ["tag-a"],
        timeoutMs: 1234,
      });

      expect(result).toEqual({
        nextPageToken: "next-page",
        sandboxes: [
          {
            sandboxId: "sandbox-123",
            status: "running",
          },
        ],
      });
      expect(listRequest).toEqual({
        showTerminated: true,
        pageSize: 10,
        pageToken: "page-1",
        status: "running",
        tags: ["tag-a"],
        timeoutMs: 1234,
      });
    });

    it("lists all sandboxes across pages as Sandbox handles", async () => {
      const listRequests: Parameters<SandboxTransport["list"]>[0][] = [];
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async list(options) {
          listRequests.push(options);
          if (listRequests.length === 1) {
            return {
              nextPageToken: "page-2",
              sandboxes: [
                {
                  sandboxId: "sandbox-a",
                  status: "running",
                },
              ],
            };
          }
          if (listRequests.length === 2) {
            return {
              nextPageToken: "page-3",
              sandboxes: [
                {
                  sandboxId: "sandbox-b",
                  status: "running",
                },
              ],
            };
          }
          return {
            sandboxes: [
              {
                sandboxId: "sandbox-c",
                status: "running",
              },
            ],
          };
        },
      };

      const sandboxes = await createClient(transport).listAll({
        pageSize: 10,
        tags: ["tag-a"],
        timeoutMs: 5_000,
      });

      expect(sandboxes).toHaveLength(3);
      expect(sandboxes.every((sandbox) => sandbox instanceof Sandbox)).toBe(true);
      expect(sandboxes.map((sandbox) => sandbox.sandboxId)).toEqual([
        "sandbox-a",
        "sandbox-b",
        "sandbox-c",
      ]);
      expect(listRequests).toHaveLength(3);
      expect(listRequests[0]).toMatchObject({ pageSize: 10, tags: ["tag-a"] });
      expect(listRequests[1]).toMatchObject({
        pageSize: 10,
        pageToken: "page-2",
        tags: ["tag-a"],
      });
      expect(listRequests[2]).toMatchObject({
        pageSize: 10,
        pageToken: "page-3",
        tags: ["tag-a"],
      });
    });

    it("yields sandboxes one by one via listSandboxes", async () => {
      let calls = 0;
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async list() {
          calls += 1;
          if (calls === 1) {
            return {
              nextPageToken: "page-2",
              sandboxes: [{ sandboxId: "sandbox-a", status: "running" }],
            };
          }
          return {
            sandboxes: [{ sandboxId: "sandbox-b", status: "running" }],
          };
        },
      };

      const ids: string[] = [];
      for await (const sandbox of createClient(transport).listSandboxes({ timeoutMs: 5_000 })) {
        ids.push(sandbox.sandboxId);
      }

      expect(ids).toEqual(["sandbox-a", "sandbox-b"]);
    });

    it("yields sandboxes page by page via listSandboxes().byPage()", async () => {
      let calls = 0;
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async list() {
          calls += 1;
          if (calls === 1) {
            return {
              nextPageToken: "page-2",
              sandboxes: [{ sandboxId: "sandbox-a", status: "running" }],
            };
          }
          return {
            sandboxes: [{ sandboxId: "sandbox-b", status: "running" }],
          };
        },
      };

      const pages: string[][] = [];
      for await (const page of createClient(transport)
        .listSandboxes({ timeoutMs: 5_000 })
        .byPage()) {
        pages.push(page.map((sandbox) => sandbox.sandboxId));
      }

      expect(pages).toEqual([["sandbox-a"], ["sandbox-b"]]);
    });

    it("collects sandboxes via listSandboxes().collect()", async () => {
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async list() {
          return {
            sandboxes: [{ sandboxId: "sandbox-a", status: "running" }],
          };
        },
      };

      const sandboxes = await createClient(transport).listSandboxes({ timeoutMs: 5_000 }).collect();

      expect(sandboxes.map((sandbox) => sandbox.sandboxId)).toEqual(["sandbox-a"]);
      expect(sandboxes.every((sandbox) => sandbox instanceof Sandbox)).toBe(true);
    });

    it("applies the default listAll timeout budget when timeoutMs is omitted", async () => {
      vi.useFakeTimers();
      let listRequest: Parameters<SandboxTransport["list"]>[0] | undefined;
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async list(options) {
          listRequest = options;
          return { sandboxes: [] };
        },
      };

      try {
        await createClient(transport).listAll({ tags: ["tag-a"] });
        expect(listRequest?.timeoutMs).toBe(DEFAULT_LIST_ALL_TIMEOUT_MS);
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats timeoutMs as a wall-clock budget across pages", async () => {
      vi.useFakeTimers();
      const timeouts: number[] = [];

      try {
        const transport: SandboxTransport = {
          ...createFakeTransport(),
          async list(options) {
            timeouts.push(options.timeoutMs ?? -1);
            vi.advanceTimersByTime(40);
            if (timeouts.length === 1) {
              return {
                nextPageToken: "page-2",
                sandboxes: [{ sandboxId: "sandbox-a", status: "running" }],
              };
            }
            return {
              sandboxes: [{ sandboxId: "sandbox-b", status: "running" }],
            };
          },
        };

        await createClient(transport).listAll({ timeoutMs: 100 });

        expect(timeouts).toEqual([100, 60]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("times out when the listAll wall-clock budget is exhausted", async () => {
      vi.useFakeTimers();

      try {
        const transport: SandboxTransport = {
          ...createFakeTransport(),
          async list() {
            vi.advanceTimersByTime(100);
            return {
              nextPageToken: "page-2",
              sandboxes: [{ sandboxId: "sandbox-a", status: "running" }],
            };
          },
        };

        await expect(createClient(transport).listAll({ timeoutMs: 100 })).rejects.toThrow(
          CWSandboxTimeoutError,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("detects repeated listAll page tokens", async () => {
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async list() {
          return {
            nextPageToken: "same-token",
            sandboxes: [{ sandboxId: "sandbox-a", status: "running" }],
          };
        },
      };

      await expect(createClient(transport).listAll({ timeoutMs: 5_000 })).rejects.toThrow(
        CWSandboxTransportError,
      );
    });

    it("rejects when listAll exceeds the page cap", async () => {
      let calls = 0;
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async list() {
          calls += 1;
          return {
            nextPageToken: `token-${calls}`,
            sandboxes: [{ sandboxId: `sandbox-${calls}`, status: "running" }],
          };
        },
      };

      await expect(createClient(transport).listAll({ timeoutMs: 60_000 })).rejects.toThrow(
        CWSandboxTransportError,
      );
      expect(calls).toBe(MAX_LIST_ALL_PAGES);
    });

    it("honors AbortSignal during listAll", async () => {
      const controller = new AbortController();
      const reason = new Error("aborted");
      controller.abort(reason);

      await expect(
        createClient().listAll({ signal: controller.signal, timeoutMs: 5_000 }),
      ).rejects.toBe(reason);
    });

    it("discards partial results when a later listAll page fails", async () => {
      let calls = 0;
      const error = new Error("list failed");
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async list() {
          calls += 1;
          if (calls === 1) {
            return {
              nextPageToken: "page-2",
              sandboxes: [{ sandboxId: "sandbox-a", status: "running" }],
            };
          }
          throw error;
        },
      };

      await expect(createClient(transport).listAll({ timeoutMs: 5_000 })).rejects.toBe(error);
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

    it("treats missing sandboxes as already deleted when missingOk is true", async () => {
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async delete(request) {
          throw new CWSandboxNotFoundError(`Sandbox '${request.sandboxId}' not found.`);
        },
      };

      await expect(
        createClient(transport).delete("missing-sandbox", { missingOk: true }),
      ).resolves.toBeUndefined();
    });

    it("raises not-found on delete when missingOk is false", async () => {
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async delete(request) {
          throw new CWSandboxNotFoundError(`Sandbox '${request.sandboxId}' not found.`);
        },
      };

      await expect(createClient(transport).delete("missing-sandbox")).rejects.toBeInstanceOf(
        CWSandboxNotFoundError,
      );
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
      await expect(client.listAll({ pageSize: -1 })).rejects.toThrow(CWSandboxValidationError);
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

    it("throws a typed validation error for invalid services", async () => {
      const client = createClient();

      await expect(client.run(["python"], { services: [{ port: 0 }] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { services: [{ port: 65536 }] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(client.run(["python"], { services: [{ port: 1.5 }] })).rejects.toThrow(
        CWSandboxValidationError,
      );
      await expect(
        client.run(["python"], { services: [{ port: 8000 }, { port: 8000 }] }),
      ).rejects.toThrow(CWSandboxValidationError);
      await expect(
        client.run(["python"], { services: [{ name: "", port: 8000 }] }),
      ).rejects.toThrow(CWSandboxValidationError);
      await expect(
        client.run(["python"], {
          services: [
            {
              endpoint: { auth: "open", kind: "https" },
              port: 8000,
            },
          ],
        }),
      ).rejects.toThrow(/Service.visibility must be PUBLIC/);
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
      let stopped = false;
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
          if (stopped) {
            events.push("get:terminated");
            return {
              sandboxId: request.sandboxId,
              status: "terminated",
            };
          }

          const status = statuses[getCalls] ?? "running";
          getCalls += 1;
          events.push(`get:${status}`);
          return {
            sandboxId: request.sandboxId,
            status,
          };
        },
        async stop(request) {
          stopped = true;
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
        "get:running",
        "stop:sandbox-for-keepalive",
        "get:terminated",
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
      // Creation skipped readiness gets; stop() still preflights and waits for terminal.
      expect(getCalls).toBe(2);
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
