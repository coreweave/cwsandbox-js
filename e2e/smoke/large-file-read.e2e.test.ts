// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { createHash } from "node:crypto";

import type { Sandbox, SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import { smokeConfig, withDedicatedTaggedSandbox } from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const MiB = 1024 * 1024;
const largeReadTimeoutMs = 10 * 60 * 1000;

describeWithCredentials("live large file read smoke", { sequential: true }, () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "reads 64 MiB and 200 MiB files intact with readStream and 64 MiB with read",
    async () => {
      await withDedicatedTaggedSandbox(
        client,
        {
          create: (tag) => client.create({ maxLifetimeSeconds: 900, tags: [tag] }),
          waitUntilRunning: true,
        },
        async (sandbox) => {
          const small = await createRandomFile(sandbox, "/tmp/large-read-64.bin", 64 * MiB);
          const large = await createRandomFile(sandbox, "/tmp/large-read-200.bin", 200 * MiB);

          for (const file of [small, large]) {
            const hash = createHash("sha256");
            let received = 0;
            for await (const chunk of sandbox.files.readStream(file.path)) {
              hash.update(chunk);
              received += chunk.byteLength;
            }
            expect(received).toBe(file.size);
            expect(hash.digest("hex")).toBe(file.sha256);
          }

          const content = await sandbox.files.read(small.path);
          expect(content.byteLength).toBe(small.size);
          expect(createHash("sha256").update(content).digest("hex")).toBe(small.sha256);
        },
      );
    },
    largeReadTimeoutMs,
  );
});

async function createRandomFile(
  sandbox: Sandbox,
  path: string,
  size: number,
): Promise<{ readonly path: string; readonly sha256: string; readonly size: number }> {
  const result = await sandbox.exec([
    "sh",
    "-c",
    `head -c ${size} /dev/urandom > "$1" && sha256sum "$1"`,
    "create-random-file",
    path,
  ]);
  expect(result.exitCode).toBe(0);
  const sha256 = result.stdout.trim().split(/\s+/)[0] ?? "";
  expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  return { path, sha256, size };
}
