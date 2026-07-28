// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it, vi } from "vitest";

import {
  CWSandboxFileError,
  CWSandboxResourceExhaustedError,
  CWSandboxTransportError,
  CWSandboxValidationError,
} from "./index.js";
import {
  CWSANDBOX_FILE_IO_FAILED,
  CWSANDBOX_FILE_TOO_LARGE,
  CWSANDBOX_FILE_TRUNCATED,
} from "./internal/error-info.js";
import {
  DEFAULT_FILE_OPERATION_CAP_BYTES,
  MAX_AUTO_FALLBACK_BYTES,
} from "./internal/file-limits.js";
import { createClient, createFakeFileAdapter } from "./test/helpers.js";
import type { FileAdapter } from "./transport/file-adapter.js";

type WriteStreamCall = { readonly mode: string; readonly path: string; readonly sandboxId: string };

describe("Sandbox files", () => {
  it("writes string files through the files namespace", async () => {
    let writeRequest: Parameters<FileAdapter["write"]>[0] | undefined;
    const fileAdapter = createFakeFileAdapter({
      async write(request) {
        writeRequest = request;
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

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
    let writeRequest: Parameters<FileAdapter["write"]>[0] | undefined;
    const fileAdapter = createFakeFileAdapter({
      async write(request) {
        writeRequest = request;
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await sandbox.files.write("/tmp/input.bin", content);

    expect(writeRequest).toEqual({
      content,
      path: "/tmp/input.bin",
      sandboxId: "sandbox-for-echo",
    });
  });

  it("writes record batch files through the files namespace", async () => {
    const writeRequests: Parameters<FileAdapter["write"]>[0][] = [];
    const fileAdapter = createFakeFileAdapter({
      async write(request) {
        writeRequests.push(request);
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

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
    const writeRequests: Parameters<FileAdapter["write"]>[0][] = [];
    const fileAdapter = createFakeFileAdapter({
      async write(request) {
        writeRequests.push(request);
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

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
    const fileAdapter = createFakeFileAdapter({
      async read() {
        return { content };
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(sandbox.files.read("/tmp/output.bin")).resolves.toBe(content);
  });

  it("reads text files through the files namespace", async () => {
    const fileAdapter = createFakeFileAdapter({
      async read() {
        return { content: new TextEncoder().encode("hello") };
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(sandbox.files.readText("/tmp/output.txt")).resolves.toBe("hello");
  });

  it("reads batch byte files through the files namespace", async () => {
    const fileAdapter = createFakeFileAdapter({
      async read(request) {
        return { content: new TextEncoder().encode(request.path) };
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(sandbox.files.read(["/tmp/a.txt", "/tmp/b.txt"])).resolves.toEqual({
      "/tmp/a.txt": new TextEncoder().encode("/tmp/a.txt"),
      "/tmp/b.txt": new TextEncoder().encode("/tmp/b.txt"),
    });
  });

  it("reads batch text files through the files namespace", async () => {
    const fileAdapter = createFakeFileAdapter({
      async read(request) {
        return { content: new TextEncoder().encode(request.path) };
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(sandbox.files.readText(["/tmp/a.txt", "/tmp/b.txt"])).resolves.toEqual({
      "/tmp/a.txt": "/tmp/a.txt",
      "/tmp/b.txt": "/tmp/b.txt",
    });
  });

  it("forwards options through batch file reads", async () => {
    const signal = new AbortController().signal;
    const readRequests: Parameters<FileAdapter["read"]>[0][] = [];
    const fileAdapter = createFakeFileAdapter({
      async read(request) {
        readRequests.push(request);
        return { content: new Uint8Array() };
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

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
    let readRequest: Parameters<FileAdapter["read"]>[0] | undefined;
    const fileAdapter = createFakeFileAdapter({
      async read(request) {
        readRequest = request;
        return { content: new Uint8Array() };
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await sandbox.files.read("/tmp/output.txt", { signal, timeoutMs: 1234 });

    expect(readRequest).toEqual({
      path: "/tmp/output.txt",
      sandboxId: "sandbox-for-echo",
      signal,
      timeoutMs: 1234,
    });
  });

  it("proactively routes writes above the unary cap through FileAdapter.writeStream (atomic)", async () => {
    const content = new Uint8Array(DEFAULT_FILE_OPERATION_CAP_BYTES + 1);
    const write = vi.fn<FileAdapter["write"]>(async () => undefined);
    const writeStreamCalls: WriteStreamCall[] = [];
    let sourceBytes = 0;

    const fileAdapter = createFakeFileAdapter({
      write,
      async writeStream(request) {
        writeStreamCalls.push({
          mode: request.mode,
          path: request.path,
          sandboxId: request.sandboxId,
        });
        if (request.source instanceof Uint8Array) {
          sourceBytes = request.source.byteLength;
        }
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await sandbox.files.write("/tmp/large.bin", content);

    expect(write).not.toHaveBeenCalled();
    expect(writeStreamCalls).toHaveLength(1);
    expect(writeStreamCalls[0]).toMatchObject({
      mode: "atomic",
      path: "/tmp/large.bin",
      sandboxId: "sandbox-for-echo",
    });
    expect(sourceBytes).toBe(content.byteLength);
  });

  it("maps FileAdapter.writeStream (atomic) errors to CWSANDBOX_FILE_IO_FAILED", async () => {
    const content = new Uint8Array(DEFAULT_FILE_OPERATION_CAP_BYTES + 1);
    const fileAdapter = createFakeFileAdapter({
      async writeStream() {
        throw new CWSandboxFileError("atomic write failed: disk full", {
          filepath: "/tmp/large.bin",
          operation: "Write file",
          reason: CWSANDBOX_FILE_IO_FAILED,
          sandboxId: "sandbox-for-echo",
        });
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(sandbox.files.write("/tmp/large.bin", content)).rejects.toMatchObject({
      filepath: "/tmp/large.bin",
      reason: CWSANDBOX_FILE_IO_FAILED,
    });
  });

  it("falls back to FileAdapter.writeStream when unary write reports FILE_TOO_LARGE", async () => {
    const content = new Uint8Array(1024);
    const writeStreamCalls: WriteStreamCall[] = [];
    const fileAdapter = createFakeFileAdapter({
      async write() {
        throw new CWSandboxTransportError(
          "file payload exceeds configured max-file-operation-bytes",
          {
            operation: "Write file",
            reason: CWSANDBOX_FILE_TOO_LARGE,
            sandboxId: "sandbox-for-echo",
          },
        );
      },
      async writeStream(request) {
        writeStreamCalls.push({
          mode: request.mode,
          path: request.path,
          sandboxId: request.sandboxId,
        });
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await sandbox.files.write("/tmp/small.bin", content);

    expect(writeStreamCalls.some((call) => call.mode === "atomic")).toBe(true);
  });

  it("falls back to FileAdapter.readStream when unary read reports FILE_TOO_LARGE with size", async () => {
    const content = new Uint8Array([9, 8, 7]);
    const fileAdapter = createFakeFileAdapter({
      async read() {
        throw new CWSandboxTransportError("file too large", {
          metadata: { size_bytes: "3" },
          operation: "Read file",
          reason: CWSANDBOX_FILE_TOO_LARGE,
          sandboxId: "sandbox-for-echo",
        });
      },
      readStream() {
        return asyncIterableFrom([content]);
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(sandbox.files.read("/tmp/large.bin")).resolves.toEqual(content);
  });

  it("falls back to FileAdapter.readStream when unary read is resource exhausted", async () => {
    const content = new Uint8Array([1, 2]);
    const fileAdapter = createFakeFileAdapter({
      async read() {
        throw new CWSandboxResourceExhaustedError("resource exhausted", {
          operation: "Read file",
          sandboxId: "sandbox-for-echo",
        });
      },
      readStream() {
        return asyncIterableFrom([content]);
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(sandbox.files.read("/tmp/large.bin")).resolves.toEqual(content);
  });

  it("falls back to FileAdapter.readStream when unary read hits the gRPC decompress size cliff", async () => {
    const content = new Uint8Array([4, 5, 6]);
    const fileAdapter = createFakeFileAdapter({
      async read() {
        throw new CWSandboxResourceExhaustedError(
          "Read file failed: Received message that decompresses to a size larger than 4194304",
          { operation: "Read file", sandboxId: "sandbox-for-echo" },
        );
      },
      readStream() {
        return asyncIterableFrom([content]);
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(sandbox.files.read("/tmp/large.bin")).resolves.toEqual(content);
  });

  it("rejects fallback reads that deliver fewer bytes than reported size", async () => {
    const fileAdapter = createFakeFileAdapter({
      async read() {
        throw new CWSandboxTransportError("file too large", {
          metadata: { size_bytes: "10" },
          operation: "Read file",
          reason: CWSANDBOX_FILE_TOO_LARGE,
          sandboxId: "sandbox-for-echo",
        });
      },
      readStream() {
        return asyncIterableFrom([new Uint8Array([1, 2])]);
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

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

  it("refuses writes above the auto-fallback ceiling without FileAdapter", async () => {
    const content = new Uint8Array(MAX_AUTO_FALLBACK_BYTES + 1);
    const write = vi.fn<FileAdapter["write"]>(async () => undefined);
    const writeStream = vi.fn<FileAdapter["writeStream"]>(async () => undefined);
    const fileAdapter = createFakeFileAdapter({ write, writeStream });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

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
    expect(write).not.toHaveBeenCalled();
    expect(writeStream).not.toHaveBeenCalled();
  });

  it("records observed unary cap and routes later writes through FileAdapter.writeStream", async () => {
    const writeStreamCalls: WriteStreamCall[] = [];
    const write = vi.fn<FileAdapter["write"]>(async (_request) => {
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
    const fileAdapter = createFakeFileAdapter({
      write,
      async writeStream(request) {
        writeStreamCalls.push({
          mode: request.mode,
          path: request.path,
          sandboxId: request.sandboxId,
        });
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await sandbox.files.write("/tmp/learn.bin", new Uint8Array(512));
    expect(write).toHaveBeenCalledOnce();
    expect(writeStreamCalls).toHaveLength(1);

    write.mockClear();
    writeStreamCalls.length = 0;

    await sandbox.files.write("/tmp/after-learn.bin", new Uint8Array(2048));
    expect(write).not.toHaveBeenCalled();
    expect(writeStreamCalls).toHaveLength(1);
  });

  it("does not auto-fallback reads when FILE_TOO_LARGE size exceeds the ceiling", async () => {
    const readStream = vi.fn<FileAdapter["readStream"]>(() => asyncIterableFrom([]));
    const error = new CWSandboxTransportError("file too large", {
      metadata: {
        size_bytes: String(MAX_AUTO_FALLBACK_BYTES + 1),
      },
      operation: "Read file",
      reason: CWSANDBOX_FILE_TOO_LARGE,
      sandboxId: "sandbox-for-echo",
    });
    const fileAdapter = createFakeFileAdapter({
      async read() {
        throw error;
      },
      readStream,
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(sandbox.files.read("/tmp/huge.bin")).rejects.toBe(error);
    expect(readStream).not.toHaveBeenCalled();
  });

  it("forwards AbortSignal into FileAdapter.writeStream fallback", async () => {
    const content = new Uint8Array(DEFAULT_FILE_OPERATION_CAP_BYTES + 1);
    const signal = AbortSignal.abort();
    const writeStream = vi.fn<FileAdapter["writeStream"]>(async (request) => {
      expect(request.signal?.aborted).toBe(true);
      request.signal?.throwIfAborted();
    });
    const fileAdapter = createFakeFileAdapter({
      write: vi.fn<FileAdapter["write"]>(async () => undefined),
      writeStream,
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(sandbox.files.write("/tmp/large.bin", content, { signal })).rejects.toThrow(
      /aborted|AbortError|This operation was aborted/i,
    );
    expect(writeStream).toHaveBeenCalledOnce();
  });
});

async function* asyncIterableFrom<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) {
    yield value;
  }
}
