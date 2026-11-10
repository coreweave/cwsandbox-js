// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError } from "./errors.js";
import type { SandboxClient } from "./public/client.js";
import { createClient, createFakeTransport, createProcessResult } from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";

const SANDBOX_UUID = "123e4567-e89b-12d3-a456-426614174000";
const compose = new TextEncoder().encode("services:\n  main:\n    image: python:3.11\n");

type CreatePath = (client: SandboxClient, displayName: string) => Promise<unknown>;

const createPaths: readonly (readonly [string, CreatePath])[] = [
  ["create", (client, displayName) => client.create({ displayName })],
  ["run", (client, displayName) => client.run(["sleep", "1"], { displayName })],
  ["runFromTemplate", (client, displayName) => client.runFromTemplate("tmpl", { displayName })],
  [
    "runFromFile",
    (client, displayName) => client.runFromFile(compose, { displayName, primaryService: "main" }),
  ],
  ["withSandbox", (client, displayName) => client.withSandbox(() => undefined, { displayName })],
  [
    "withSandboxFromTemplate",
    (client, displayName) =>
      client.withSandboxFromTemplate("tmpl", () => undefined, { displayName }),
  ],
  [
    "withSandboxFromFile",
    (client, displayName) =>
      client.withSandboxFromFile(compose, () => undefined, {
        displayName,
        primaryService: "main",
      }),
  ],
];

function recordingTransport(): {
  readonly sent: (string | undefined)[];
  readonly transport: SandboxTransport;
} {
  const sent: (string | undefined)[] = [];
  const result = { displayName: "my-box", sandboxId: SANDBOX_UUID, status: "running" as const };
  return {
    sent,
    transport: {
      ...createFakeTransport(),
      async start(request) {
        sent.push(request.displayName);
        return result;
      },
      async startFromTemplate(request) {
        sent.push(request.displayName);
        return result;
      },
      async startFromFile(request) {
        sent.push(request.displayName);
        return result;
      },
    },
  };
}

describe("sandbox display names", () => {
  it.each(createPaths)("%s sends displayName to the transport", async (_name, start) => {
    const { sent, transport } = recordingTransport();

    await start(createClient(transport), "my-box");

    expect(sent).toEqual(["my-box"]);
  });

  it.each(createPaths)(
    "%s rejects an invalid displayName before the transport",
    async (_n, start) => {
      const { sent, transport } = recordingTransport();

      await expect(start(createClient(transport), "a/b")).rejects.toThrow(CWSandboxValidationError);
      await expect(start(createClient(transport), SANDBOX_UUID)).rejects.toThrow(
        CWSandboxValidationError,
      );
      expect(sent).toEqual([]);
    },
  );

  it("reads displayName back on the handle and keeps it across refreshes", async () => {
    const { transport } = recordingTransport();
    const sandbox = await createClient(transport).create({ displayName: "my-box" });

    expect(sandbox.displayName).toBe("my-box");
    await sandbox.inspect();
    expect(sandbox.displayName).toBe("my-box");
  });

  it("fromId resolves a name and uses the returned UUID for later calls", async () => {
    const calls: string[] = [];
    let stopped = false;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        calls.push(`get:${request.sandboxId}`);
        const status = stopped ? "terminated" : "running";
        return { displayName: "my-box", sandboxId: SANDBOX_UUID, status };
      },
      async exec(request) {
        calls.push(`exec:${request.sandboxId}`);
        return createProcessResult(request.command);
      },
      async stop(request) {
        calls.push(`stop:${request.sandboxId}`);
        stopped = true;
      },
    };

    const sandbox = await createClient(transport).fromId("my-box");
    await sandbox.exec(["true"]);
    await sandbox.inspect();
    await sandbox.stop();

    expect(sandbox.sandboxId).toBe(SANDBOX_UUID);
    expect(sandbox.displayName).toBe("my-box");
    expect(calls[0]).toBe("get:my-box");
    expect(calls.slice(1)).not.toContain("get:my-box");
    expect(calls).toContain(`exec:${SANDBOX_UUID}`);
    expect(calls).toContain(`stop:${SANDBOX_UUID}`);
  });
});
