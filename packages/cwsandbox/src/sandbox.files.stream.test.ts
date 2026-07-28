// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxFileError,
  CWSandboxStreamBackpressureError,
  CWSandboxValidationError,
  STREAM_BACKPRESSURE,
} from "./index.js";
import {
  CWSANDBOX_FILE_IO_FAILED,
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_TRUNCATED,
} from "./internal/error-info.js";
import { TRUNCATION_CHECK_MIN_BYTES } from "./internal/file-limits.js";
import { createClient, createFakeFileAdapter } from "./test/helpers.js";
import type { FileAdapter } from "./transport/file-adapter.js";

describe("Sandbox files streaming", () => {
  it("writeStream delegates to FileAdapter.writeStream with mode='direct'", async () => {
    let writeStreamRequest: Parameters<FileAdapter["writeStream"]>[0] | undefined;
    const fileAdapter = createFakeFileAdapter({
      async writeStream(request) {
        writeStreamRequest = request;
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await sandbox.files.writeStream("/tmp/stream.bin", [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4, 5]),
    ]);

    expect(writeStreamRequest).toMatchObject({
      mode: "direct",
      path: "/tmp/stream.bin",
      sandboxId: "sandbox-for-echo",
    });
  });

  it("writeStream passes through the source iterable to FileAdapter", async () => {
    const chunks: Uint8Array[] = [];
    const fileAdapter = createFakeFileAdapter({
      async writeStream(request) {
        const source = request.source;
        if (Symbol.asyncIterator in Object(source)) {
          for await (const chunk of source as AsyncIterable<Uint8Array>) {
            chunks.push(chunk);
          }
        } else if (source instanceof Uint8Array) {
          chunks.push(source);
        } else if (Symbol.iterator in Object(source)) {
          for (const chunk of source as Iterable<Uint8Array>) {
            chunks.push(chunk);
          }
        }
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await sandbox.files.writeStream("/tmp/stream.bin", [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4, 5]),
    ]);

    expect(chunks.map((c) => Array.from(c))).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
  });

  it("writeStream aborts when AbortSignal fires", async () => {
    const abortController = new AbortController();
    const fileAdapter = createFakeFileAdapter({
      async writeStream(request) {
        abortController.abort();
        request.signal?.throwIfAborted();
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(
      sandbox.files.writeStream("/tmp/partial.bin", [new Uint8Array([1])], {
        signal: abortController.signal,
      }),
    ).rejects.toThrow(/aborted|AbortError|This operation was aborted/i);
  });

  it("writeStream rejects non-Uint8Array chunks with CWSandboxValidationError", async () => {
    const chunks: unknown[] = [];
    const fileAdapter = createFakeFileAdapter({
      async writeStream(request) {
        const source = request.source;
        if (Symbol.iterator in Object(source) && !(source instanceof Uint8Array)) {
          for (const chunk of source as Iterable<Uint8Array>) {
            chunks.push(chunk);
          }
        }
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(
      sandbox.files.writeStream("/tmp/bad.bin", [123 as unknown as Uint8Array]),
    ).rejects.toBeInstanceOf(CWSandboxValidationError);
    expect(chunks).toEqual([]);
  });

  it("writeStream does not remask stream backpressure as a file error", async () => {
    const fileAdapter = createFakeFileAdapter({
      async writeStream() {
        throw new CWSandboxStreamBackpressureError("too slow", {
          streamCode: STREAM_BACKPRESSURE,
        });
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(
      sandbox.files.writeStream("/tmp/bp.bin", [new Uint8Array([1])]),
    ).rejects.toBeInstanceOf(CWSandboxStreamBackpressureError);
  });

  it("writeStream propagates CWSandboxFileError from FileAdapter", async () => {
    const fileAdapter = createFakeFileAdapter({
      async writeStream() {
        throw new CWSandboxFileError("permission denied", {
          filepath: "/tmp/fail.bin",
          operation: "Write file",
          reason: CWSANDBOX_FILE_IO_FAILED,
          sandboxId: "sandbox-for-echo",
        });
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(
      sandbox.files.writeStream("/tmp/fail.bin", [new Uint8Array([1])]),
    ).rejects.toMatchObject({
      filepath: "/tmp/fail.bin",
      reason: CWSANDBOX_FILE_IO_FAILED,
    });
  });

  it("readStream delegates to FileAdapter.readStream", async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    let readStreamRequest: Parameters<FileAdapter["readStream"]>[0] | undefined;
    const fileAdapter = createFakeFileAdapter({
      readStream(request) {
        readStreamRequest = request;
        return asyncIterableFrom(chunks);
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    const received: number[] = [];
    for await (const chunk of sandbox.files.readStream("/tmp/out.bin")) {
      received.push(...chunk);
    }

    expect(received).toEqual([1, 2, 3]);
    expect(readStreamRequest).toMatchObject({
      path: "/tmp/out.bin",
      sandboxId: "sandbox-for-echo",
    });
  });

  it("readStream propagates CWSandboxFileError for missing-file codes", async () => {
    const fileAdapter = createFakeFileAdapter({
      readStream() {
        return asyncIterableWithError(
          new CWSandboxFileError("file not found", {
            filepath: "/missing",
            operation: "Read file",
            reason: CWSANDBOX_FILE_NOT_FOUND,
            sandboxId: "sandbox-for-echo",
          }),
        );
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(async () => {
      for await (const _chunk of sandbox.files.readStream("/missing")) {
        // drain
      }
    }).rejects.toMatchObject({
      name: "CWSandboxFileError",
      reason: CWSANDBOX_FILE_NOT_FOUND,
    });
  });

  it("readStream propagates truncation errors from FileAdapter", async () => {
    const expected = TRUNCATION_CHECK_MIN_BYTES;
    const fileAdapter = createFakeFileAdapter({
      readStream() {
        return asyncIterableWithError(
          new CWSandboxFileError(
            `readStream of '/tmp/big.bin' was truncated: got 3 of ${expected} bytes.`,
            {
              filepath: "/tmp/big.bin",
              metadata: {
                bytes_delivered: "3",
                filepath: "/tmp/big.bin",
                operation: "read_file_streaming",
                size_bytes: String(expected),
              },
              operation: "Read file",
              reason: CWSANDBOX_FILE_TRUNCATED,
              sandboxId: "sandbox-for-echo",
            },
          ),
        );
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(async () => {
      for await (const _chunk of sandbox.files.readStream("/tmp/big.bin")) {
        // drain
      }
    }).rejects.toMatchObject({
      name: "CWSandboxFileError",
      reason: CWSANDBOX_FILE_TRUNCATED,
    });
  });

  it("readStream does not remask stream backpressure as a file error", async () => {
    const fileAdapter = createFakeFileAdapter({
      readStream() {
        return asyncIterableWithError(
          new CWSandboxStreamBackpressureError("too slow", {
            streamCode: STREAM_BACKPRESSURE,
          }),
        );
      },
    });
    const sandbox = await createClient(undefined, fileAdapter).run(["echo", "hello"]);

    await expect(async () => {
      for await (const _chunk of sandbox.files.readStream("/tmp/bp.bin")) {
        // drain
      }
    }).rejects.toBeInstanceOf(CWSandboxStreamBackpressureError);
  });

  it("readStream rejects when path is empty", async () => {
    const sandbox = await createClient().run(["echo", "hello"]);

    await expect(async () => {
      for await (const _chunk of sandbox.files.readStream("")) {
        // drain
      }
    }).rejects.toBeInstanceOf(CWSandboxValidationError);
  });

  it("writeStream rejects when path is empty", async () => {
    const sandbox = await createClient().run(["echo", "hello"]);

    await expect(sandbox.files.writeStream("", [new Uint8Array([1])])).rejects.toBeInstanceOf(
      CWSandboxValidationError,
    );
  });
});

async function* asyncIterableFrom<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) {
    yield value;
  }
}

function asyncIterableWithError(error: unknown): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let thrown = false;
      return {
        async next() {
          if (!thrown) {
            thrown = true;
            throw error;
          }
          return { done: true, value: undefined as never };
        },
        async return() {
          return { done: true, value: undefined as never };
        },
      };
    },
  };
}
