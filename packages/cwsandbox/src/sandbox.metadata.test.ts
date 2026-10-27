// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { afterEach, describe, expect, it, vi } from "vitest";

import { CWSandboxExecutionError } from "./errors.js";
import type { GetSandboxResult } from "./public/sandbox.js";
import { createClient, createFakeTransport, createProcessResult } from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";

const createdAt = new Date("2026-01-01T00:00:00Z");

describe("sandbox discovery metadata", () => {
  it.each(["fromId", "listAll", "create"] as const)(
    "exposes defensive copies through %s",
    async (factory) => {
      const tags = ["team:ml"];
      const date = new Date(createdAt);
      const metadata = {
        sandboxId: "metadata-test",
        status: "running" as const,
        tags,
        createdAt: date,
      };
      const transport: SandboxTransport = {
        ...createFakeTransport(["running"]),
        async start() {
          return metadata;
        },
        async get() {
          return metadata;
        },
        async list() {
          return { sandboxes: [metadata] };
        },
      };
      const client = createClient(transport);
      const sandbox =
        factory === "fromId"
          ? await client.fromId("metadata-test")
          : factory === "listAll"
            ? (await client.listAll())[0]
            : await client.create({ waitUntilRunning: false });
      if (sandbox === undefined) {
        throw new Error("expected a listed sandbox");
      }
      tags.push("changed");
      date.setFullYear(2000);
      expect(sandbox.tags).toEqual(["team:ml"]);
      expect(sandbox.createdAt).toEqual(createdAt);
      sandbox.createdAt?.setFullYear(2001);
      expect(sandbox.createdAt).toEqual(createdAt);
      expect(sandbox.tags).not.toBe(sandbox.tags);
      await sandbox.inspect();
      expect(sandbox.tags).toEqual(["team:ml", "changed"]);
    },
  );

  it("clears tags on refresh and handles missing creation time", async () => {
    let first = true;
    const sandbox = await createClient({
      ...createFakeTransport(["running"]),
      async get() {
        const result = {
          sandboxId: "metadata-test",
          status: "running" as const,
          ...(first ? { tags: ["old"] } : {}),
        };
        first = false;
        return result;
      },
    }).fromId("metadata-test");
    expect(sandbox.tags).toEqual(["old"]);
    await sandbox.inspect();
    expect(sandbox.tags).toEqual([]);
    expect(sandbox.createdAt).toBeUndefined();
  });
});

describe("sandbox status read-back", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const readBack: GetSandboxResult = {
    sandboxId: "read-back",
    status: "running",
    attachedVolumeIds: ["vol-1"],
    containerStatuses: [{ name: "main", restartCount: 0, status: "running" }],
    effectiveEgress: [
      { dnsName: "pypi.org" },
      { cidr: { cidr: "10.0.0.0/8", exceptCidrs: ["10.1.0.0/16"] }, ports: [{ port: 53 }] },
      { selector: { podLabels: { app: "db" } } },
    ],
    effectiveIngress: [{ any: true, ports: [{ port: 8080 }] }],
    effectiveRuntimeClass: "gvisor",
  };

  it.each(["fromId", "listAll", "create"] as const)(
    "exposes read-back fields through %s as defensive copies",
    async (factory) => {
      const transport: SandboxTransport = {
        ...createFakeTransport(["running"]),
        async start() {
          return readBack;
        },
        async get() {
          return readBack;
        },
        async list() {
          return { sandboxes: [readBack] };
        },
      };
      const client = createClient(transport);
      const sandbox =
        factory === "fromId"
          ? await client.fromId("read-back")
          : factory === "listAll"
            ? (await client.listAll())[0]
            : await client.create({ waitUntilRunning: false });
      if (sandbox === undefined) {
        throw new Error("expected a listed sandbox");
      }

      expect(sandbox.attachedVolumeIds).toEqual(readBack.attachedVolumeIds);
      expect(sandbox.containerStatuses).toEqual(readBack.containerStatuses);
      expect(sandbox.effectiveEgress).toEqual(readBack.effectiveEgress);
      expect(sandbox.effectiveIngress).toEqual(readBack.effectiveIngress);
      expect(sandbox.effectiveRuntimeClass).toBe("gvisor");
      expect(sandbox.effectiveEgress?.[1]?.cidr?.exceptCidrs).not.toBe(
        readBack.effectiveEgress?.[1]?.cidr?.exceptCidrs,
      );
      expect(sandbox.effectiveEgress?.[2]?.selector?.podLabels).not.toBe(
        readBack.effectiveEgress?.[2]?.selector?.podLabels,
      );
      expect(sandbox.effectiveIngress?.[0]?.ports).not.toBe(readBack.effectiveIngress?.[0]?.ports);
    },
  );

  it("refreshes read-back fields and statusUpdatedAt on inspect", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    let calls = 0;
    const sandbox = await createClient({
      ...createFakeTransport(["running"]),
      async get() {
        calls += 1;
        return calls === 1
          ? readBack
          : {
              ...readBack,
              containerStatuses: [{ exitCode: 1, name: "main", restartCount: 1, status: "failed" }],
            };
      },
    }).fromId("read-back");
    expect(sandbox.statusUpdatedAt).toEqual(new Date("2026-01-01T00:00:00Z"));

    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    await sandbox.inspect();

    expect(sandbox.statusUpdatedAt).toEqual(new Date("2026-01-01T00:00:05Z"));
    expect(sandbox.containerStatuses).toEqual([
      { exitCode: 1, name: "main", restartCount: 1, status: "failed" },
    ]);
  });

  it("counts exec outcomes", async () => {
    const results = [0, 2, 3];
    const sandbox = await createClient({
      ...createFakeTransport(["running"]),
      async exec(request) {
        const exitCode = results.shift();
        if (exitCode === undefined) {
          throw new Error("transport down");
        }
        return createProcessResult(request.command, { exitCode });
      },
    }).create({ waitUntilRunning: false });
    expect(sandbox.execStats).toEqual({
      execCount: 0,
      execCompletedOk: 0,
      execCompletedNonzero: 0,
      execFailures: 0,
    });

    await sandbox.exec(["true"]);
    await sandbox.commands.run(["false"]);
    await expect(sandbox.exec(["false"], { check: true })).rejects.toBeInstanceOf(
      CWSandboxExecutionError,
    );
    await expect(sandbox.exec(["echo"])).rejects.toThrow("transport down");

    expect(sandbox.execStats).toEqual({
      execCount: 4,
      execCompletedOk: 1,
      execCompletedNonzero: 1,
      execFailures: 2,
    });
  });
});
