// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { createClient, createFakeTransport } from "./test/helpers.js";
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
