// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, expect, it } from "vitest";

import {
  assertIncremental,
  binaryPayload,
  describeStress,
  expectSandboxHealthy,
  installStressSummary,
  recordBytes,
  sha256,
  stressConfig,
  withStressContext,
} from "./helpers.js";

describeStress("stress commands", () => {
  let client: SandboxClient | undefined;

  installStressSummary(() => client);

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "waits for high-volume stdout without consuming streams",
    async () => {
      const bytes = stressConfig.limits.streamBytes;

      await withStressContext(currentClient(), "commands-high-output", async (context) =>
        context.withRunningSandbox(["/bin/sh", "-lc", "sleep infinity"], async (sandbox) => {
          const process = await sandbox.commands.start([
            "python",
            "-c",
            `import sys; sys.stdout.write('x' * ${bytes}); sys.stdout.flush()`,
          ]);
          const result = await context.phase(
            "wait for high-volume command",
            process.wait({ timeoutMs: 30_000 }),
          );

          recordBytes(result.stdoutBytesProduced);
          expect(result.exitCode).toBe(0);
          expect(result.stdoutBytesProduced).toBe(bytes);
        }),
      );
    },
    stressConfig.timeoutMs,
  );

  it(
    "streams mixed stdout and stderr output",
    async () => {
      const count = Math.min(100, stressConfig.limits.lineCount);

      await withStressContext(currentClient(), "commands-mixed-streams", async (context) =>
        context.withRunningSandbox(["/bin/sh", "-lc", "sleep infinity"], async (sandbox) => {
          const process = await sandbox.commands.start([
            "python",
            "-c",
            [
              "import sys",
              `count = ${count}`,
              "for i in range(count):",
              "    print(f'out-{i}')",
              "    print(f'err-{i}', file=sys.stderr)",
            ].join("\n"),
          ]);
          const [stdout, stderr, result] = await Promise.all([
            context.collectFor(process.stdout, count, "collect stdout"),
            context.collectFor(process.stderr, count, "collect stderr"),
            context.phase("wait for mixed stream command", process.wait()),
          ]);

          expect(result.exitCode).toBe(0);
          expect(stdout.join("").match(/out-/g)?.length).toBe(count);
          expect(stderr.join("").match(/err-/g)?.length).toBe(count);
        }),
      );
    },
    stressConfig.timeoutMs,
  );

  it(
    "proves command stdout arrives incrementally",
    async () => {
      await withStressContext(currentClient(), "commands-incremental", async (context) =>
        context.withRunningSandbox(["/bin/sh", "-lc", "sleep infinity"], async (sandbox) => {
          const process = await sandbox.commands.start([
            "/bin/sh",
            "-lc",
            "for i in 1 2 3 4; do echo incremental-$i; sleep 0.2; done",
          ]);
          const arrivals: number[] = [];
          const lines: string[] = [];

          for await (const chunk of process.stdout) {
            arrivals.push(Date.now());
            lines.push(chunk);
          }
          const result = await context.phase("wait for incremental command", process.wait());

          expect(result.exitCode).toBe(0);
          expect(lines.join("")).toContain("incremental-4");
          assertIncremental(arrivals, { minEvents: 4, minSpreadMs: 250 });
        }),
      );
    },
    stressConfig.timeoutMs,
  );

  it(
    "keeps live stream larger than buffered result cap",
    async () => {
      await withStressContext(currentClient(), "commands-truncation", async (context) =>
        context.withRunningSandbox(["/bin/sh", "-lc", "sleep infinity"], async (sandbox) => {
          const process = await sandbox.commands.start(["python", "-c", "print('x' * 4096)"], {
            bufferedMaxKiB: 1,
          });
          const stdout = await context.collectFor(process.stdout, 10, "collect truncation stdout");
          const result = await context.phase("wait for truncation command", process.wait());

          expect(stdout.join("").length).toBeGreaterThan(result.stdout.length);
          expect(result.stdoutTruncated).toBe(true);
        }),
      );
    },
    stressConfig.timeoutMs,
  );

  it(
    "cancels a long-running streaming command and keeps sandbox healthy",
    async () => {
      await withStressContext(currentClient(), "commands-cancel", async (context) =>
        context.withRunningSandbox(["/bin/sh", "-lc", "sleep infinity"], async (sandbox) => {
          const process = await sandbox.commands.start([
            "/bin/sh",
            "-lc",
            "while true; do echo tick; sleep 1; done",
          ]);
          const stdout = context.collectFor(process.stdout, 1, "collect cancel tick");

          await expect(stdout).resolves.toEqual([expect.stringContaining("tick")]);
          await process.cancel();
          await expect(process.wait()).rejects.toThrow("Streaming command cancelled.");
          await expectSandboxHealthy(sandbox);
        }),
      );
    },
    stressConfig.timeoutMs,
  );

  it(
    "handles chunked binary stdin",
    async () => {
      const payload = binaryPayload(4096);
      const expectedHash = sha256(payload);
      const chunkSize = 512;

      await withStressContext(currentClient(), "commands-stdin", async (context) =>
        context.withRunningSandbox(["/bin/sh", "-lc", "sleep infinity"], async (sandbox) => {
          const process = await sandbox.commands.start(
            [
              "python",
              "-c",
              "import hashlib, sys; data=sys.stdin.buffer.read(); print(len(data)); print(hashlib.sha256(data).hexdigest())",
            ],
            { stdin: true },
          );

          for (let offset = 0; offset < payload.byteLength; offset += chunkSize) {
            await context.phase(
              `write stdin chunk ${offset / chunkSize}`,
              process.stdin.write(payload.slice(offset, offset + chunkSize)),
              5_000,
            );
          }
          await context.phase("close stdin", process.stdin.close(), 10_000);

          const result = await context.phase("wait for stdin command", process.wait(), 30_000);

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain(String(payload.byteLength));
          expect(result.stdout).toContain(expectedHash);
        }),
      );
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
