// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { Sandbox, SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, expect, it } from "vitest";

import {
  binaryPayload,
  describeStress,
  installStressSummary,
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

  function currentClient(): SandboxClient {
    if (client === undefined) {
      throw new Error("Client has not been initialized.");
    }

    return client;
  }
});
