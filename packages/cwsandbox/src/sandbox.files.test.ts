// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it, vi } from "vitest";

import {
  CWSandboxFileError,
  CWSandboxResourceExhaustedError,
  CWSandboxTransportError,
  CWSandboxValidationError,
  type CommandInputData,
  type SandboxTransport,
} from "./index.js";
import {
  CWSANDBOX_FILE_IS_DIRECTORY,
  CWSANDBOX_FILE_IO_FAILED,
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_TOO_LARGE,
  CWSANDBOX_FILE_TRUNCATED,
} from "./internal/error-info.js";
import {
  DEFAULT_FILE_OPERATION_CAP_BYTES,
  MAX_AUTO_FALLBACK_BYTES,
} from "./internal/file-limits.js";
import type { InternalCommandProcessWithStdin } from "./internal/start-command-options.js";
import {
  createClient,
  createCommandInputWriter,
  createCommandProcess,
  createFakeTransport,
  createProcessResult,
} from "./test/helpers.js";

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

  it("proactively routes writes above the unary cap through StreamExec", async () => {
    const content = new Uint8Array(DEFAULT_FILE_OPERATION_CAP_BYTES + 1);
    const writeFile = vi.fn<SandboxTransport["writeFile"]>(async () => undefined);
    let startRequest: Parameters<SandboxTransport["startCommand"]>[0] | undefined;
    const stdinChunks: Uint8Array[] = [];

    const transport: SandboxTransport = {
      ...createFakeTransport(),
      writeFile,
      async startCommand(request) {
        startRequest = request;
        const process = createCommandProcess(
          request.command,
          true,
        ) as InternalCommandProcessWithStdin;
        const stdin = createCommandInputWriter();
        return {
          ...process,
          stdin: {
            ...stdin,
            async write(data: CommandInputData) {
              stdinChunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
            },
          },
          async wait() {
            return createProcessResult(request.command, { exitCode: 0 });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.files.write("/tmp/large.bin", content);

    expect(writeFile).not.toHaveBeenCalled();
    expect(startRequest?.command[0]).toBe("/bin/sh");
    expect(startRequest?.command).toContain("/tmp/large.bin");
    expect(startRequest?.binaryOutput).toBe(true);
    const script = String(startRequest?.command[2] ?? "");
    expect(script).toContain('tmp="$path.tmp.$$"');
    expect(script).toContain("trap 'rm -f \"$tmp\"' EXIT");
    expect(script).toContain('mv -f "$tmp" "$path"');
    expect(script).toContain("trap - EXIT");
    expect(stdinChunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(
      content.byteLength,
    );
  });

  it("maps StreamExec write non-zero exits to CWSANDBOX_FILE_IO_FAILED", async () => {
    const content = new Uint8Array(DEFAULT_FILE_OPERATION_CAP_BYTES + 1);
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        const process = createCommandProcess(
          request.command,
          true,
        ) as InternalCommandProcessWithStdin;
        return {
          ...process,
          status: "running",
          async wait() {
            return createProcessResult(request.command, {
              exitCode: 1,
              stderr: "disk full",
            });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.write("/tmp/large.bin", content)).rejects.toMatchObject({
      filepath: "/tmp/large.bin",
      reason: CWSANDBOX_FILE_IO_FAILED,
    });
  });

  it("cancels StreamExec write fallback when stdin write fails", async () => {
    const content = new Uint8Array(DEFAULT_FILE_OPERATION_CAP_BYTES + 1);
    let cancelled = false;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async startCommand(request) {
        const process = createCommandProcess(
          request.command,
          true,
        ) as InternalCommandProcessWithStdin;
        const stdin = createCommandInputWriter();
        return {
          ...process,
          status: "running",
          stdin: {
            ...stdin,
            async write() {
              throw new Error("write timed out");
            },
          },
          async cancel() {
            cancelled = true;
          },
          async wait() {
            return createProcessResult(request.command, { exitCode: 0 });
          },
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.write("/tmp/large.bin", content)).rejects.toMatchObject({
      filepath: "/tmp/large.bin",
      reason: CWSANDBOX_FILE_IO_FAILED,
    });
    expect(cancelled).toBe(true);
  });

  it("falls back to StreamExec when unary write reports FILE_TOO_LARGE", async () => {
    const content = new Uint8Array(1024);
    const startCommand = vi.fn<SandboxTransport["startCommand"]>(async (request) => {
      if (request.stdin === true) {
        const process = createCommandProcess(
          request.command,
          true,
        ) as InternalCommandProcessWithStdin;
        return {
          ...process,
          async wait() {
            return createProcessResult(request.command, { exitCode: 0 });
          },
        };
      }
      return createCommandProcess(request.command);
    });
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async writeFile() {
        throw new CWSandboxTransportError(
          "file payload exceeds configured max-file-operation-bytes",
          {
            operation: "Write file",
            reason: CWSANDBOX_FILE_TOO_LARGE,
            sandboxId: "sandbox-for-echo",
          },
        );
      },
      startCommand,
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.files.write("/tmp/small.bin", content);

    expect(startCommand.mock.calls.some((call) => call[0].stdin === true)).toBe(true);
  });

  it("falls back to StreamExec when unary read reports FILE_TOO_LARGE with size", async () => {
    const content = new Uint8Array([9, 8, 7]);
    const startCommand = vi.fn<SandboxTransport["startCommand"]>(async (request) => {
      const process = createCommandProcess(request.command);
      return {
        ...process,
        async wait() {
          return createProcessResult(request.command, {
            exitCode: 0,
            stdoutBytes: content,
          });
        },
      };
    });
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile() {
        throw new CWSandboxTransportError("file too large", {
          metadata: {
            size_bytes: "3",
          },
          operation: "Read file",
          reason: CWSANDBOX_FILE_TOO_LARGE,
          sandboxId: "sandbox-for-echo",
        });
      },
      startCommand,
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.read("/tmp/large.bin")).resolves.toEqual(content);
    expect(startCommand).toHaveBeenCalledOnce();
    expect(startCommand.mock.calls[0]?.[0].command[0]).toBe("/bin/sh");
    expect(startCommand.mock.calls[0]?.[0].binaryOutput).toBe(true);
  });

  it("falls back to StreamExec when unary read is resource exhausted", async () => {
    const content = new Uint8Array([1, 2]);
    const startCommand = vi.fn<SandboxTransport["startCommand"]>(async (request) => {
      const process = createCommandProcess(request.command);
      return {
        ...process,
        async wait() {
          return createProcessResult(request.command, {
            exitCode: 0,
            stdoutBytes: content,
          });
        },
      };
    });
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile() {
        throw new CWSandboxResourceExhaustedError("resource exhausted", {
          operation: "Read file",
          sandboxId: "sandbox-for-echo",
        });
      },
      startCommand,
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.read("/tmp/large.bin")).resolves.toEqual(content);
    expect(startCommand).toHaveBeenCalledOnce();
  });

  it("falls back to StreamExec when unary read hits the gRPC decompress size cliff", async () => {
    const content = new Uint8Array([4, 5, 6]);
    const startCommand = vi.fn<SandboxTransport["startCommand"]>(async (request) => {
      const process = createCommandProcess(request.command);
      return {
        ...process,
        async wait() {
          return createProcessResult(request.command, {
            exitCode: 0,
            stdoutBytes: content,
          });
        },
      };
    });
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile() {
        throw new CWSandboxResourceExhaustedError(
          "Read file failed: Received message that decompresses to a size larger than 4194304",
          { operation: "Read file", sandboxId: "sandbox-for-echo" },
        );
      },
      startCommand,
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.read("/tmp/large.bin")).resolves.toEqual(content);
    expect(startCommand).toHaveBeenCalledOnce();
  });

  it("rejects StreamExec reads when the client buffer truncates stdout", async () => {
    const startCommand = vi.fn<SandboxTransport["startCommand"]>(async (request) => {
      const process = createCommandProcess(request.command);
      return {
        ...process,
        async wait() {
          return createProcessResult(request.command, {
            exitCode: 0,
            stdoutBytes: new Uint8Array([1, 2, 3]),
            stdoutTruncated: true,
          });
        },
      };
    });
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile() {
        throw new CWSandboxTransportError("file too large", {
          metadata: {
            size_bytes: "3",
          },
          operation: "Read file",
          reason: CWSANDBOX_FILE_TOO_LARGE,
          sandboxId: "sandbox-for-echo",
        });
      },
      startCommand,
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    const truncated = await sandbox.files.read("/tmp/large.bin").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(truncated).toBeInstanceOf(CWSandboxFileError);
    expect(truncated).toMatchObject({
      filepath: "/tmp/large.bin",
      reason: CWSANDBOX_FILE_TRUNCATED,
    });
  });

  it("rejects StreamExec reads that deliver fewer bytes than reported size", async () => {
    const startCommand = vi.fn<SandboxTransport["startCommand"]>(async (request) => {
      const process = createCommandProcess(request.command);
      return {
        ...process,
        async wait() {
          return createProcessResult(request.command, {
            exitCode: 0,
            stdoutBytes: new Uint8Array([1, 2]),
          });
        },
      };
    });
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile() {
        throw new CWSandboxTransportError("file too large", {
          metadata: {
            size_bytes: "10",
          },
          operation: "Read file",
          reason: CWSANDBOX_FILE_TOO_LARGE,
          sandboxId: "sandbox-for-echo",
        });
      },
      startCommand,
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.read("/tmp/large.bin")).rejects.toMatchObject({
      filepath: "/tmp/large.bin",
      message: expect.stringMatching(/truncated: got 2 of 10/),
      metadata: expect.objectContaining({
        bytes_delivered: "2",
        size_bytes: "10",
      }),
      reason: CWSANDBOX_FILE_TRUNCATED,
    });
  });

  it("maps StreamExec read exit codes to AIP-193 file reasons", async () => {
    for (const [exitCode, reason] of [
      [2, CWSANDBOX_FILE_NOT_FOUND],
      [3, CWSANDBOX_FILE_IS_DIRECTORY],
      [1, CWSANDBOX_FILE_IO_FAILED],
    ] as const) {
      const startCommand = vi.fn<SandboxTransport["startCommand"]>(async (request) => {
        const process = createCommandProcess(request.command);
        return {
          ...process,
          async wait() {
            return createProcessResult(request.command, {
              exitCode,
              stderr: `exit ${exitCode}`,
            });
          },
        };
      });
      const transport: SandboxTransport = {
        ...createFakeTransport(),
        async readFile() {
          throw new CWSandboxTransportError("file too large", {
            metadata: { size_bytes: "3" },
            operation: "Read file",
            reason: CWSANDBOX_FILE_TOO_LARGE,
            sandboxId: "sandbox-for-echo",
          });
        },
        startCommand,
      };
      const sandbox = await createClient(transport).run(["echo", "hello"]);

      const error = await sandbox.files.read("/tmp/large.bin").then(
        () => undefined,
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(CWSandboxFileError);
      expect(error).toMatchObject({
        filepath: "/tmp/large.bin",
        reason,
      });
    }
  });

  it("refuses writes above the auto-fallback ceiling without StreamExec", async () => {
    const content = new Uint8Array(MAX_AUTO_FALLBACK_BYTES + 1);
    const writeFile = vi.fn<SandboxTransport["writeFile"]>(async () => undefined);
    const startCommand = vi.fn<SandboxTransport["startCommand"]>(async (request) =>
      createCommandProcess(request.command, true),
    );
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      writeFile,
      startCommand,
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    const error = await sandbox.files.write("/tmp/huge.bin", content).then(
      () => undefined,
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(CWSandboxFileError);
    expect(error).toMatchObject({
      filepath: "/tmp/huge.bin",
      message: expect.stringContaining("auto-fallback ceiling"),
      reason: CWSANDBOX_FILE_TOO_LARGE,
    });
    expect(writeFile).not.toHaveBeenCalled();
    expect(startCommand).not.toHaveBeenCalled();
  });

  it("records observed unary cap and routes later writes through StreamExec", async () => {
    const writeFile = vi.fn<SandboxTransport["writeFile"]>(async () => {
      throw new CWSandboxTransportError("file too large", {
        metadata: {
          max_size_bytes: "1024",
          size_bytes: "2048",
        },
        operation: "Write file",
        reason: CWSANDBOX_FILE_TOO_LARGE,
        sandboxId: "sandbox-for-echo",
      });
    });
    const startCommand = vi.fn<SandboxTransport["startCommand"]>(async (request) => {
      const process = createCommandProcess(
        request.command,
        true,
      ) as InternalCommandProcessWithStdin;
      return {
        ...process,
        async wait() {
          return createProcessResult(request.command, { exitCode: 0 });
        },
      };
    });
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      writeFile,
      startCommand,
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.files.write("/tmp/learn.bin", new Uint8Array(512));
    expect(writeFile).toHaveBeenCalledOnce();
    expect(startCommand).toHaveBeenCalledOnce();

    writeFile.mockClear();
    startCommand.mockClear();

    await sandbox.files.write("/tmp/after-learn.bin", new Uint8Array(2048));
    expect(writeFile).not.toHaveBeenCalled();
    expect(startCommand).toHaveBeenCalledOnce();
  });

  it("does not auto-fallback reads when FILE_TOO_LARGE size exceeds the ceiling", async () => {
    const startCommand = vi.fn<SandboxTransport["startCommand"]>(async (request) =>
      createCommandProcess(request.command),
    );
    const error = new CWSandboxTransportError("file too large", {
      metadata: {
        size_bytes: String(MAX_AUTO_FALLBACK_BYTES + 1),
      },
      operation: "Read file",
      reason: CWSANDBOX_FILE_TOO_LARGE,
      sandboxId: "sandbox-for-echo",
    });
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async readFile() {
        throw error;
      },
      startCommand,
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.read("/tmp/huge.bin")).rejects.toBe(error);
    expect(startCommand).not.toHaveBeenCalled();
  });

  it("forwards AbortSignal into StreamExec fallback writes", async () => {
    const content = new Uint8Array(DEFAULT_FILE_OPERATION_CAP_BYTES + 1);
    const signal = AbortSignal.abort();
    const startCommand = vi.fn<SandboxTransport["startCommand"]>(async (request) => {
      expect(request.signal?.aborted).toBe(true);
      const process = createCommandProcess(
        request.command,
        true,
      ) as InternalCommandProcessWithStdin;
      return {
        ...process,
        async wait(options) {
          options?.signal?.throwIfAborted();
          return createProcessResult(request.command, { exitCode: 0 });
        },
      };
    });
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      writeFile: vi.fn<SandboxTransport["writeFile"]>(async () => undefined),
      startCommand,
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.files.write("/tmp/large.bin", content, { signal })).rejects.toThrow(
      /aborted|AbortError|This operation was aborted/i,
    );
    expect(startCommand).toHaveBeenCalledOnce();
  });
});
