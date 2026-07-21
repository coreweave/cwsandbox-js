// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, expect, it } from "vitest";

import {
  collectWithLimit,
  describeStress,
  installStressSummary,
  recordBytes,
  recordFiles,
  recordLogLines,
  sha256,
  stressConfig,
  withStressContext,
} from "./helpers.js";

describeStress("stress workflows", () => {
  let client: SandboxClient | undefined;

  installStressSummary(() => client);

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "combines logs, files, command mutation, and readback verification",
    async () => {
      await withStressContext(currentClient(), "workflow", async (context) => {
        const inputPath = `/tmp/${context.marker}-input.txt`;
        const outputPath = `/tmp/${context.marker}-output.txt`;
        const initialContent = `${context.marker}-initial\n`;
        const updatedContent = `${context.marker}-updated\n`;
        const expectedHash = sha256(updatedContent);

        await context.withRunningSandbox(
          [
            "/bin/sh",
            "-lc",
            [
              `printf '${context.marker}-boot\\n'`,
              `while [ ! -f ${outputPath} ]; do printf '${context.marker}-waiting\\n'; sleep 0.2; done`,
              `printf '${context.marker}-done\\n'`,
              "sleep infinity",
            ].join("; "),
          ],
          async (sandbox) => {
            await sandbox.files.write({ [inputPath]: initialContent });
            recordFiles(1);

            const logs = await sandbox.logs.stream({ follow: true });
            const logLinesPromise = collectWithLimit(logs, 20, async (line) => {
              if (line.includes(`${context.marker}-done`)) {
                await logs.close();
              }
            });

            const mutate = await sandbox.commands.run([
              "/bin/sh",
              "-lc",
              `test -s ${inputPath} && printf ${JSON.stringify(updatedContent)} > ${outputPath}`,
            ]);
            expect(mutate.exitCode).toBe(0);

            const logLines = await logLinesPromise;
            recordLogLines(logLines.length);
            expect(logLines.join("")).toContain(`${context.marker}-done`);

            const readBack = await sandbox.files.readText(outputPath);
            expect(readBack).toBe(updatedContent);

            const checksumResult = await sandbox.commands.run([
              "python",
              "-c",
              `import hashlib; print(hashlib.sha256(open(${JSON.stringify(outputPath)}, 'rb').read()).hexdigest())`,
            ]);
            expect(checksumResult.exitCode).toBe(0);
            expect(checksumResult.stdout.trim()).toBe(expectedHash);
            recordBytes(readBack.length);
          },
        );
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
