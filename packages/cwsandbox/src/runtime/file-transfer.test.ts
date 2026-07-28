// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxFileError,
  CWSandboxTransportError,
  CWSandboxValidationError,
} from "../errors.js";
import { CWSANDBOX_FILE_TOO_LARGE } from "../internal/error-info.js";
import { DEFAULT_FILE_OPERATION_CAP_BYTES } from "../internal/file-limits.js";
import type { FileAdapter, WriteStreamRequest } from "../transport/file-adapter.js";
import { FileTransfer } from "./file-transfer.js";

describe("FileTransfer", () => {
  it("routes small writes through unary adapter.write", async () => {
    const writes: Uint8Array[] = [];
    const adapter = createFakeAdapter({
      write: async (request) => {
        writes.push(request.content);
      },
    });
    const transfer = new FileTransfer("sbx", adapter);

    await transfer.writeSingle("/tmp/a.bin", new Uint8Array([1, 2, 3]), {});

    expect(writes).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it("uses atomic writeStream when size exceeds the unary cap", async () => {
    const streamRequests: WriteStreamRequest[] = [];
    const adapter = createFakeAdapter({
      writeStream: async (request) => {
        streamRequests.push(request);
      },
    });
    const transfer = new FileTransfer("sbx", adapter);
    const bytes = new Uint8Array(DEFAULT_FILE_OPERATION_CAP_BYTES + 1);

    await transfer.writeSingle("/tmp/large.bin", bytes, {});

    expect(streamRequests).toHaveLength(1);
    expect(streamRequests[0]?.mode).toBe("atomic");
    expect(streamRequests[0]?.expectedBytes).toBe(bytes.byteLength);
  });

  it("falls back to atomic writeStream on FILE_TOO_LARGE", async () => {
    const streamRequests: WriteStreamRequest[] = [];
    const adapter = createFakeAdapter({
      write: async () => {
        throw new CWSandboxTransportError("too large", {
          reason: CWSANDBOX_FILE_TOO_LARGE,
          metadata: { max_size_bytes: "1024" },
        });
      },
      writeStream: async (request) => {
        streamRequests.push(request);
      },
    });
    const transfer = new FileTransfer("sbx", adapter);

    await transfer.writeSingle("/tmp/a.bin", new Uint8Array(512), {});

    expect(streamRequests[0]?.mode).toBe("atomic");
    expect(transfer.observedFileOpCapBytes).toBe(1024);
  });

  it("uses direct mode for writeStream", async () => {
    const streamRequests: WriteStreamRequest[] = [];
    const adapter = createFakeAdapter({
      writeStream: async (request) => {
        streamRequests.push(request);
      },
    });
    const transfer = new FileTransfer("sbx", adapter);

    await transfer.writeStream("/tmp/a.bin", new Uint8Array([9]), {});

    expect(streamRequests[0]?.mode).toBe("direct");
  });

  it("rejects non-Uint8Array writeStream chunks with CWSandboxValidationError", async () => {
    const seen: unknown[] = [];
    const adapter = createFakeAdapter({
      writeStream: async (request) => {
        const source = request.source;
        if (Symbol.iterator in Object(source) && !(source instanceof Uint8Array)) {
          for (const chunk of source as Iterable<Uint8Array>) {
            seen.push(chunk);
          }
        }
      },
    });
    const transfer = new FileTransfer("sbx", adapter);

    await expect(
      transfer.writeStream("/tmp/bad.bin", [123 as unknown as Uint8Array], {}),
    ).rejects.toBeInstanceOf(CWSandboxValidationError);
    expect(seen).toEqual([]);
  });

  it("rejects truncated fallback reads", async () => {
    const adapter = createFakeAdapter({
      read: async () => {
        throw new CWSandboxTransportError("too large", {
          reason: CWSANDBOX_FILE_TOO_LARGE,
          metadata: { size_bytes: "10" },
        });
      },
      readStream: () =>
        (async function* () {
          yield new Uint8Array([1, 2, 3]);
        })(),
    });
    const transfer = new FileTransfer("sbx", adapter);

    await expect(transfer.readSingle("/tmp/a.bin", {})).rejects.toBeInstanceOf(CWSandboxFileError);
  });
});

function createFakeAdapter(overrides: Partial<FileAdapter> = {}): FileAdapter {
  return {
    read: overrides.read ?? (async () => ({ content: new Uint8Array() })),
    write: overrides.write ?? (async () => undefined),
    readStream: overrides.readStream ?? (() => emptyChunks()),
    writeStream: overrides.writeStream ?? (async () => undefined),
  };
}

async function* emptyChunks(): AsyncIterable<Uint8Array> {
  // no chunks
}
