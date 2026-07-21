// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError, type SandboxTransport } from "./index.js";
import { createClient, createFakeTransport } from "./test/helpers.js";

describe("Sandbox files", () => {
  it("writes string files through the files namespace", async () => {
    let writeRequest: Parameters<SandboxTransport["writeFile"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async writeFile(request) {
        writeRequest = request;
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.files.write("/tmp/input.txt", "hello", { timeoutMs: 1234 });

    expect(writeRequest).toEqual({
      content: new TextEncoder().encode("hello"),
      path: "/tmp/input.txt",
      sandboxId: "sandbox-for-echo",
      timeoutMs: 1234,
    });
  });

  it("writes byte files through the files namespace", async () => {
    const content = new Uint8Array([1, 2, 3]);
    let writeRequest: Parameters<SandboxTransport["writeFile"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async writeFile(request) {
        writeRequest = request;
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.files.write("/tmp/input.bin", content);

    expect(writeRequest).toEqual({
      content,
      path: "/tmp/input.bin",
      sandboxId: "sandbox-for-echo",
    });
  });

  it("writes record batch files through the files namespace", async () => {
    const writeRequests: Parameters<SandboxTransport["writeFile"]>[0][] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async writeFile(request) {
        writeRequests.push(request);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.files.write(
      {
        "/tmp/a.txt": "a",
        "/tmp/b.txt": "b",
      },
      { timeoutMs: 1234 },
    );

    expect(writeRequests).toEqual([
      {
        content: new TextEncoder().encode("a"),
        path: "/tmp/a.txt",
        sandboxId: "sandbox-for-echo",
        timeoutMs: 1234,
      },
      {
        content: new TextEncoder().encode("b"),
        path: "/tmp/b.txt",
        sandboxId: "sandbox-for-echo",
        timeoutMs: 1234,
      },
    ]);
  });

  it("writes array batch files through the files namespace", async () => {
    const content = new Uint8Array([1, 2, 3]);
    const writeRequests: Parameters<SandboxTransport["writeFile"]>[0][] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async writeFile(request) {
        writeRequests.push(request);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.files.write([
      { content: "a", path: "/tmp/a.txt" },
      { content, path: "/tmp/b.bin" },
    ]);

    expect(writeRequests).toEqual([
      {
        content: new TextEncoder().encode("a"),
        path: "/tmp/a.txt",
        sandboxId: "sandbox-for-echo",
      },
      {
        content,
        path: "/tmp/b.bin",
        sandboxId: "sandbox-for-echo",
      },
    ]);
  });

  it("throws typed validation errors for invalid file writes", async () => {
    const sandbox = await createClient().run(["echo", "hello"]);

    await expect(
      sandbox.files.write([
        { content: "a", path: "/tmp/a.txt" },
        { content: "b", path: "/tmp/a.txt" },
      ]),
    ).rejects.toThrow(CWSandboxValidationError);
    await expect(sandbox.files.write({ "tmp/a.txt": "a" })).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(sandbox.files.write([{ content: "a", path: "" }])).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(sandbox.files.write("/tmp/input.txt", "hello", { timeoutMs: -1 })).rejects.toThrow(
      CWSandboxValidationError,
    );
  });

  it("reads byte files through the files namespace", async () => {
    const content = new Uint8Array([1, 2, 3]);
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile() {
        return {
          content,
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.read("/tmp/output.bin")).resolves.toBe(content);
  });

  it("reads text files through the files namespace", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile() {
        return {
          content: new TextEncoder().encode("hello"),
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.readText("/tmp/output.txt")).resolves.toBe("hello");
  });

  it("reads batch byte files through the files namespace", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile(request) {
        return {
          content: new TextEncoder().encode(request.path),
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.read(["/tmp/a.txt", "/tmp/b.txt"])).resolves.toEqual({
      "/tmp/a.txt": new TextEncoder().encode("/tmp/a.txt"),
      "/tmp/b.txt": new TextEncoder().encode("/tmp/b.txt"),
    });
  });

  it("reads batch text files through the files namespace", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile(request) {
        return {
          content: new TextEncoder().encode(request.path),
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.readText(["/tmp/a.txt", "/tmp/b.txt"])).resolves.toEqual({
      "/tmp/a.txt": "/tmp/a.txt",
      "/tmp/b.txt": "/tmp/b.txt",
    });
  });

  it("forwards options through batch file reads", async () => {
    const signal = new AbortController().signal;
    const readRequests: Parameters<SandboxTransport["readFile"]>[0][] = [];
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile(request) {
        readRequests.push(request);
        return {
          content: new Uint8Array(),
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.files.read(["/tmp/a.txt", "/tmp/b.txt"], { signal, timeoutMs: 1234 });

    expect(readRequests).toEqual([
      {
        path: "/tmp/a.txt",
        sandboxId: "sandbox-for-echo",
        signal,
        timeoutMs: 1234,
      },
      {
        path: "/tmp/b.txt",
        sandboxId: "sandbox-for-echo",
        signal,
        timeoutMs: 1234,
      },
    ]);
  });

  it("throws typed validation errors for invalid file reads", async () => {
    const sandbox = await createClient().run(["echo", "hello"]);

    await expect(sandbox.files.read(["/tmp/a.txt", "/tmp/a.txt"])).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(sandbox.files.read(["tmp/a.txt"])).rejects.toThrow(CWSandboxValidationError);
    await expect(sandbox.files.readText([""])).rejects.toThrow(CWSandboxValidationError);
    await expect(sandbox.files.read("/tmp/output.txt", { timeoutMs: -1 })).rejects.toThrow(
      CWSandboxValidationError,
    );
  });

  it("forwards read options through the files namespace", async () => {
    const signal = new AbortController().signal;
    let readRequest: Parameters<SandboxTransport["readFile"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile(request) {
        readRequest = request;
        return {
          content: new Uint8Array(),
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.files.read("/tmp/output.txt", { signal, timeoutMs: 1234 });

    expect(readRequest).toEqual({
      path: "/tmp/output.txt",
      sandboxId: "sandbox-for-echo",
      signal,
      timeoutMs: 1234,
    });
  });
});
