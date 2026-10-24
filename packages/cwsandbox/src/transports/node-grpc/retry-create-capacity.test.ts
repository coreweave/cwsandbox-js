// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";
import { describe, expect, it, vi } from "vitest";

import { createClient } from "../../test/helpers.js";
import { Sandbox as ProtoSandbox, State } from "./generated/coreweave/sandbox/v1/sandbox.js";
import { GrpcSandboxTransport } from "./grpc-transport.js";
import { retryCreateCapacity } from "./retry-create-capacity.js";
import { statusDetailsMeta } from "./test/status-details.js";

function capacity(
  reason = "CWSANDBOX_RUNNER_CAPACITY_EXHAUSTED",
  code = "RESOURCE_EXHAUSTED",
  domain = "cwsandbox.com",
): RpcError {
  return new RpcError(
    "busy",
    code,
    statusDetailsMeta({ errorInfos: [{ reason, domain }], retryInfos: [{ retrySeconds: 1 }] }),
  );
}
function clock() {
  let ms = 0;
  return {
    now: () => ms,
    sleep: async (delay: number) => {
      ms += delay;
    },
    random: () => 0,
  };
}

describe("capacity retries", () => {
  it.each(["CWSANDBOX_RUNNER_CAPACITY_EXHAUSTED", "CWSANDBOX_RUNNER_OVERLOADED"])(
    "retries %s with a server hint and bounded timeout",
    async (reason) => {
      const attempt = vi
        .fn<(timeoutMs: number | undefined) => Promise<string>>()
        .mockRejectedValueOnce(capacity(reason))
        .mockResolvedValue("ok");
      const timer = clock();
      await expect(
        retryCreateCapacity(attempt, { ...timer, createRetryBudgetMs: 5_000 }),
      ).resolves.toBe("ok");
      expect(timer.now()).toBe(1_000);
      expect(attempt.mock.calls).toEqual([[undefined], [4_000]]);
    },
  );
  it.each([
    capacity("CWSANDBOX_RUNNER_CAPACITY_EXHAUSTED", "PERMISSION_DENIED"),
    capacity("CWSANDBOX_RUNNER_CAPACITY_EXHAUSTED", "RESOURCE_EXHAUSTED", "untrusted.example"),
    capacity("CWSANDBOX_QUOTA_EXCEEDED"),
    new RpcError("bare capacity", "RESOURCE_EXHAUSTED"),
    new RpcError("ambiguous", "UNAVAILABLE"),
    new RpcError("timeout", "DEADLINE_EXCEEDED"),
  ])("does not retry unrelated or ambiguous errors", async (error) => {
    const attempt = vi
      .fn<(timeoutMs: number | undefined) => Promise<string>>()
      .mockRejectedValue(error);
    await expect(
      retryCreateCapacity(attempt, { ...clock(), createRetryBudgetMs: 5_000 }),
    ).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
  it("is disabled by default", async () => {
    const error = capacity();
    const attempt = vi
      .fn<(timeoutMs: number | undefined) => Promise<string>>()
      .mockRejectedValue(error);
    await expect(retryCreateCapacity(attempt, {})).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
  it.each([{ createRetryBudgetMs: 500 }, { createRetryBudgetMs: 5_000, timeoutMs: 500 }])(
    "does not dispatch after budget/deadline exhaustion",
    async (options) => {
      const error = capacity();
      const attempt = vi
        .fn<(timeoutMs: number | undefined) => Promise<string>>()
        .mockRejectedValue(error);
      await expect(retryCreateCapacity(attempt, { ...clock(), ...options })).rejects.toBe(error);
      expect(attempt).toHaveBeenCalledTimes(1);
    },
  );
  it("cancels backoff without another create", async () => {
    const controller = new AbortController();
    const attempt = vi
      .fn<(timeoutMs: number | undefined) => Promise<string>>()
      .mockRejectedValue(capacity());
    await expect(
      retryCreateCapacity(attempt, {
        createRetryBudgetMs: 5_000,
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("create factory retries", () => {
  it.each(["create", "template", "file"] as const)(
    "preserves the serialized body and key for %s",
    async (kind) => {
      const bodies: unknown[] = [];
      const rpc = (body: unknown): { response: Promise<unknown> } => {
        bodies.push(body);
        return {
          response:
            bodies.length === 1
              ? Promise.reject(
                  new RpcError(
                    "busy",
                    "UNAVAILABLE",
                    statusDetailsMeta({
                      errorInfos: [{ reason: "CWSANDBOX_RUNNER_OVERLOADED" }],
                      retryInfos: [{ retryNanos: 1_000_000 }],
                    }),
                  ),
                )
              : Promise.resolve(
                  ProtoSandbox.create({
                    sandboxId: "capacity-test",
                    status: { state: State.RUNNING },
                  }),
                ),
        };
      };
      const transport = new GrpcSandboxTransport({ apiKey: "test", baseUrl: "http://127.0.0.1:1" });
      Object.defineProperty(transport, "client", {
        value: { createSandbox: rpc, createSandboxFromTemplate: rpc, createSandboxFromFile: rpc },
      });
      const client = createClient(transport);
      const options = { createRetryBudgetMs: 5_000, waitUntilRunning: false };
      const sandbox =
        kind === "create"
          ? await client.create(options)
          : kind === "template"
            ? await client.runFromTemplate("template-test", options)
            : await client.runFromFile(
                new TextEncoder().encode("services:\n  main:\n    image: alpine\n"),
                { ...options, primaryService: "main" },
              );
      expect(sandbox.sandboxId).toBe("capacity-test");
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
      expect(bodies[0]).toHaveProperty("requestId", expect.stringMatching(/^[a-f0-9-]{36}$/));
      expect(bodies[0]).not.toHaveProperty("createRetryBudgetMs");
    },
  );

  it.each([-1, NaN, Infinity, -Infinity])(
    "validates retry budget %s before any create",
    async (createRetryBudgetMs) => {
      const client = createClient();
      await expect(client.create({ createRetryBudgetMs })).rejects.toThrow(/createRetryBudgetMs/);
      await expect(
        client.runFromTemplate("template-test", { createRetryBudgetMs }),
      ).rejects.toThrow(/createRetryBudgetMs/);
      await expect(
        client.runFromFile(new Uint8Array([1]), { primaryService: "main", createRetryBudgetMs }),
      ).rejects.toThrow(/createRetryBudgetMs/);
    },
  );
});

describe("capacity retry pacing", () => {
  it("uses bounded jitter when no server hint is present", async () => {
    const timer = clock();
    const error = new RpcError(
      "busy",
      "RESOURCE_EXHAUSTED",
      statusDetailsMeta({ errorInfos: [{ reason: "CWSANDBOX_RUNNER_CAPACITY_EXHAUSTED" }] }),
    );
    const attempt = vi
      .fn<(timeoutMs: number | undefined) => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");
    await retryCreateCapacity(attempt, { ...timer, createRetryBudgetMs: 1_000 });
    expect(timer.now()).toBe(200);
    expect(attempt.mock.calls).toEqual([[undefined], [800]]);
  });
  it("does not dispatch after a backoff oversleeps", async () => {
    let now = 0;
    const error = capacity();
    const attempt = vi
      .fn<(timeoutMs: number | undefined) => Promise<string>>()
      .mockRejectedValue(error);
    await expect(
      retryCreateCapacity(attempt, {
        createRetryBudgetMs: 5_000,
        now: () => now,
        sleep: async () => {
          now = 6_000;
        },
      }),
    ).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
