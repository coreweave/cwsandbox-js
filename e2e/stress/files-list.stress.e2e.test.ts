// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { Sandbox, SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, expect, it } from "vitest";

import {
  captureOp,
  combineCleanupError,
  createPatternedPayload,
  expectBytesEqual,
} from "../smoke/helpers.js";
import {
  LARGE_FILE_20_MIB,
  LARGE_FILE_40_MIB,
  binaryPayload,
  describeStress,
  installStressSummary,
  largeFileDeleteTimeoutMs,
  largeFileJourneyTimeoutMs,
  largeFileRequestOptions,
  largeFileTestTimeoutMs,
  recordFiles,
  sha256,
  stressConfig,
  stressMarker,
  textPayload,
  withStressContext,
  withStressSandbox,
} from "./helpers.js";

describeStress("stress files and list", () => {
  let client: SandboxClient | undefined;

  installStressSummary(() => client);

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "round-trips many small text files and verifies inside sandbox",
    async () => {
      const marker = stressMarker("files-small");
      const files = Object.fromEntries(
        Array.from({ length: stressConfig.limits.batchFileCount }, (_, index) => [
          `/tmp/${marker}-${index}.txt`,
          `${marker}-content-${index}`,
        ]),
      );

      await withStressSandbox(
        currentClient(),
        ["/bin/sh", "-lc", "sleep infinity"],
        async (sandbox) => {
          await sandbox.files.write(files);
          recordFiles(Object.keys(files).length);

          const readBack = await sandbox.files.readText(Object.keys(files));
          expect(readBack).toEqual(files);

          const verifyScript = [
            "from pathlib import Path",
            `marker = ${JSON.stringify(marker)}`,
            "matches = sorted(Path('/tmp').glob(f'{marker}-*.txt'))",
            "print(len(matches))",
          ].join("; ");
          const result = await sandbox.commands.run(["python", "-c", verifyScript]);

          expect(result.exitCode).toBe(0);
          expect(Number(result.stdout.trim())).toBe(Object.keys(files).length);
        },
      );
    },
    stressConfig.timeoutMs,
  );

  it(
    "round-trips binary and moderately sized files with checksums",
    async () => {
      const marker = stressMarker("files-binary");
      const small = binaryPayload(1024);
      const large = binaryPayload(stressConfig.limits.fileBytes);
      const files = [
        { content: small, path: `/tmp/${marker}-small.bin` },
        { content: large, path: `/tmp/${marker}-large.bin` },
        { content: textPayload(4096, marker), path: `/tmp/${marker}-text.txt` },
      ];

      await withStressSandbox(
        currentClient(),
        ["/bin/sh", "-lc", "sleep infinity"],
        async (sandbox) => {
          await sandbox.files.write(files);
          recordFiles(files.length);

          const expectedHashes = Object.fromEntries(
            files.map((file) => [file.path, sha256(file.content)]),
          );
          const script = [
            "import hashlib, json",
            `paths = ${JSON.stringify(files.map((file) => file.path))}`,
            "print(json.dumps({path: hashlib.sha256(open(path, 'rb').read()).hexdigest() for path in paths}, sort_keys=True))",
          ].join("; ");
          const result = await sandbox.commands.run(["python", "-c", script]);

          expect(result.exitCode).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual(expectedHashes);
        },
      );
    },
    stressConfig.timeoutMs,
  );

  it(
    "lists several tagged sandboxes through low-page-size pagination",
    async () => {
      await withStressContext(currentClient(), "list-pagination", async (context) => {
        const sandboxes: Sandbox[] = [];
        for (let index = 0; index < stressConfig.limits.paginationSandboxes; index += 1) {
          const sandbox = await context.createSandbox(["/bin/sh", "-lc", "sleep infinity"]);
          sandboxes.push(sandbox);
          await context.phase("wait for pagination sandbox", sandbox.wait());
        }

        for (const sandbox of sandboxes) {
          let pageToken: string | undefined;
          let found = false;

          for (let page = 0; page < stressConfig.limits.paginationSandboxes + 10; page += 1) {
            const result = await currentClient().list({
              pageSize: 1,
              ...(pageToken === undefined ? {} : { pageToken }),
              tags: [stressConfig.tag],
            });

            found ||= result.sandboxes.some((listed) => listed.sandboxId === sandbox.sandboxId);
            if (found || result.nextPageToken === undefined) {
              break;
            }
            pageToken = result.nextPageToken;
          }

          expect(found).toBe(true);
        }
      });
    },
    stressConfig.timeoutMs,
  );

  it(
    "round-trips a 20 MiB file (Python known-good size) at 256Mi",
    async () => {
      const payload = createPatternedPayload(LARGE_FILE_20_MIB);
      const readBack = await roundTripLargeFile(payload);
      expectBytesEqual(readBack, payload);
      expect(readBack.byteLength).toBe(LARGE_FILE_20_MIB);
    },
    largeFileTestTimeoutMs,
  );

  it(
    "round-trips a 40 MiB file via StreamExec fallback at 256Mi",
    async () => {
      const payload = createPatternedPayload(LARGE_FILE_40_MIB);
      const readBack = await roundTripLargeFile(payload);
      expectBytesEqual(readBack, payload);
      expect(readBack.byteLength).toBe(LARGE_FILE_40_MIB);
    },
    largeFileTestTimeoutMs,
  );

  async function roundTripLargeFile(payload: Uint8Array): Promise<Uint8Array> {
    const path = `/tmp/cwsandbox-js-large-write-${String(payload.byteLength)}.bin`;
    const signal = AbortSignal.timeout(largeFileJourneyTimeoutMs);
    const deadlineMs = Date.now() + largeFileJourneyTimeoutMs;
    let sandbox: Sandbox | undefined;
    let readBack: Uint8Array | undefined;

    const primary = await captureOp(async () => {
      sandbox = await currentClient().create({
        resources: { cpu: "500m", memory: "256Mi" },
        tags: [stressConfig.tag],
        ...largeFileRequestOptions(signal, deadlineMs),
      });
      await sandbox.files.write(path, payload, largeFileRequestOptions(signal, deadlineMs));
      readBack = await sandbox.files.read(path, largeFileRequestOptions(signal, deadlineMs));
    });
    const cleanup = await captureOp(async () => {
      await sandbox?.delete({ missingOk: true, timeoutMs: largeFileDeleteTimeoutMs });
    });
    combineCleanupError(primary, cleanup);
    if (readBack === undefined) {
      throw new Error("large-file read did not complete");
    }
    return readBack;
  }

  function currentClient(): SandboxClient {
    if (client === undefined) {
      throw new Error("Client has not been initialized.");
    }

    return client;
  }
});
