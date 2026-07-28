// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Incremental file streaming with files.writeStream / readStream.
 *
 * Uses a modest payload so the example stays practical; scale FILE_BYTES up
 * for a heavier soak (Python's large_file_streaming.py uses 128 MiB).
 */

import { CWSandboxStreamBackpressureError } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

const FILE_BYTES = 2 * 1024 * 1024;
const REMOTE_PATH = "/tmp/big.bin";
const CHUNK = 64 * 1024;

async function* generateChunks(totalBytes: number): AsyncGenerator<Uint8Array> {
  let remaining = totalBytes;
  while (remaining > 0) {
    const size = Math.min(CHUNK, remaining);
    const chunk = new Uint8Array(size);
    chunk.fill(0xab);
    yield chunk;
    remaining -= size;
  }
}

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  await client.withSandbox(
    async (sandbox) => {
      console.log(`Writing ${FILE_BYTES} bytes to ${REMOTE_PATH} via writeStream...`);
      await sandbox.files.writeStream(REMOTE_PATH, generateChunks(FILE_BYTES));

      console.log("Reading back with a fast-drain loop...");
      let total = 0;
      try {
        for await (const chunk of sandbox.files.readStream(REMOTE_PATH)) {
          total += chunk.byteLength;
        }
      } catch (error) {
        if (error instanceof CWSandboxStreamBackpressureError) {
          console.error("Stream backpressure — drain faster or reduce producer rate.");
          throw error;
        }
        throw error;
      }

      console.log(`Read ${total} bytes (expected ${FILE_BYTES})`);
      if (total !== FILE_BYTES) {
        throw new Error(`Byte count mismatch: got ${total}, expected ${FILE_BYTES}`);
      }
      console.log("Large-file streaming ok.");
    },
    { tags: ["example", "example-large-file-streaming"] },
  );
}

await main();
