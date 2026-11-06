// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxFileError } from "./errors.js";
import { CWSANDBOX_FILE_TOO_LARGE } from "./internal/error-info.js";
import type { Container } from "./public/containers.js";
import { createClient, createFakeFileAdapter, createFakeTransport } from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";
import type { FileAdapter } from "./transport/file-adapter.js";
import type { StartSandboxRequest } from "./transport/types.js";

const containers: readonly Container[] = [
  { image: "python:3.11", name: "main", primary: true, resources: { cpu: "1" } },
  { image: "redis:7", name: "cache", resources: { cpu: "1" } },
];

describe("multi-container create", () => {
  it("sends containers without the keep-alive command and reads them back", async () => {
    const starts: StartSandboxRequest[] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        starts.push(request);
        return { containers, sandboxId: "sbx-multi", status: "running" };
      },
    };

    const sandbox = await createClient(transport).create({ containers });

    expect(starts[0]).not.toHaveProperty("command");
    expect(starts[0]?.containers).toEqual(containers);
    expect(sandbox.containers).toEqual(containers);
    expect(sandbox.containers).not.toBe(sandbox.containers);
  });

  it("rejects containers with a run() command before calling the transport", async () => {
    const starts: StartSandboxRequest[] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async start(request) {
        starts.push(request);
        return { sandboxId: "sbx", status: "running" };
      },
    };

    await expect(createClient(transport).run(["sleep", "60"], { containers })).rejects.toThrow(
      "containers is mutually exclusive with single-container options (command)",
    );
    expect(starts).toEqual([]);
  });
});

describe("container option", () => {
  it("passes container through exec, commands.start, shell, and logs", async () => {
    const seen: (string | undefined)[] = [];
    const base = createFakeTransport();
    const transport: SandboxTransport = {
      ...base,
      async exec(request) {
        seen.push(request.container);
        return base.exec(request);
      },
      startCommand: ((request: Parameters<SandboxTransport["startCommand"]>[0]) => {
        seen.push(request.container);
        return base.startCommand(request);
      }) as SandboxTransport["startCommand"],
      async startShell(request) {
        seen.push(request.container);
        return base.startShell(request);
      },
      async streamLogs(request) {
        seen.push(request.container);
        return base.streamLogs(request);
      },
    };
    const sandbox = await createClient(transport).create();

    await sandbox.exec(["hostname"], { container: "cache" });
    await sandbox.commands.start(["cat"], { container: "cache" });
    await sandbox.shell({ container: "cache" });
    await sandbox.logs.read({ container: "cache" });
    await sandbox.exec(["hostname"]);

    expect(seen).toEqual(["cache", "cache", "cache", "cache", undefined]);
  });

  it("passes container through file calls, including the StreamExec fallback", async () => {
    const seen: [string, string | undefined][] = [];
    const tooLarge = new CWSandboxFileError("too large", {
      metadata: { size_bytes: "4" },
      reason: CWSANDBOX_FILE_TOO_LARGE,
    });
    const fileAdapter: FileAdapter = createFakeFileAdapter({
      async read(request) {
        seen.push(["read", request.container]);
        throw tooLarge;
      },
      readStream(request) {
        seen.push(["readStream", request.container]);
        return (async function* () {
          yield new Uint8Array([1, 2, 3, 4]);
        })();
      },
      async write(request) {
        seen.push(["write", request.container]);
      },
      async writeStream(request) {
        seen.push(["writeStream", request.container]);
      },
    });
    const sandbox = await createClient(createFakeTransport(), fileAdapter).create();

    await sandbox.files.read("/tmp/a", { container: "cache" });
    await sandbox.files.write("/tmp/a", "x", { container: "cache" });
    await sandbox.files.writeStream("/tmp/a", new Uint8Array([1]), { container: "cache" });

    expect(seen).toEqual([
      ["read", "cache"],
      ["readStream", "cache"],
      ["write", "cache"],
      ["writeStream", "cache"],
    ]);
  });

  it("passes container through the atomic StreamExec write fallback", async () => {
    const seen: [string, string | undefined, string | undefined][] = [];
    const fileAdapter: FileAdapter = createFakeFileAdapter({
      async write(request) {
        seen.push(["write", request.container, undefined]);
        throw new CWSandboxFileError("too large", {
          metadata: { size_bytes: "1" },
          reason: CWSANDBOX_FILE_TOO_LARGE,
        });
      },
      async writeStream(request) {
        seen.push(["writeStream", request.container, request.mode]);
      },
    });
    const sandbox = await createClient(createFakeTransport(), fileAdapter).create();

    await sandbox.files.write("/tmp/a", "x", { container: "cache" });

    expect(seen).toEqual([
      ["write", "cache", undefined],
      ["writeStream", "cache", "atomic"],
    ]);
  });

  it("rejects a non-string container", async () => {
    const sandbox = await createClient().create();

    await expect(sandbox.exec(["true"], { container: 1 as unknown as string })).rejects.toThrow(
      "container must be a string.",
    );
    await expect(
      sandbox.files.read("/tmp/a", { container: 1 as unknown as string }),
    ).rejects.toThrow("container must be a string.");
  });
});
