// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, expect, it } from "vitest";

import {
  collectWithLimit,
  describeStress,
  expectSandboxHealthy,
  installStressSummary,
  recordBytes,
  recordLogLines,
  stressConfig,
  withStressContext,
} from "./helpers.js";

describeStress("stress logs", () => {
  let client: SandboxClient | undefined;

  installStressSummary(() => client);

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "reads many finite log lines with tail slicing",
    async () => {
      const lineCount = stressConfig.limits.lineCount;
      const tailLines = 25;

      await withStressContext(currentClient(), "logs-lines", async (context) =>
        context.withRunningSandbox(
          [
            "/bin/sh",
            "-lc",
            `for i in $(seq 1 ${lineCount}); do printf '${context.marker}-%04d\\n' "$i"; done; sleep infinity`,
          ],
          async (sandbox) => {
            const lines = await context.phase("read tailed logs", sandbox.logs.read({ tailLines }));

            recordLogLines(lines.length);
            expect(lines).toHaveLength(tailLines);
            expect(lines[0]).toBe(
              `${context.marker}-${String(lineCount - tailLines + 1).padStart(4, "0")}\n`,
            );
            expect(lines.at(-1)).toBe(`${context.marker}-${String(lineCount).padStart(4, "0")}\n`);
          },
        ),
      );
    },
    stressConfig.timeoutMs,
  );

  it(
    "streams follow logs emitted after attachment",
    async () => {
      await withStressContext(currentClient(), "logs-incremental", async (context) =>
        context.withRunningSandbox(
          [
            "/bin/sh",
            "-lc",
            `while [ ! -f /tmp/${context.marker}.go ]; do sleep 0.05; done; for i in 1 2 3 4; do printf '${context.marker}-%s\\n' "$i"; sleep 0.2; done; sleep infinity`,
          ],
          async (sandbox) => {
            const stream = await context.phase(
              "open follow log stream",
              sandbox.logs.stream({ follow: true }),
            );
            const lines: string[] = [];

            try {
              await context.writeTrigger(sandbox);
              const collected = await context.collectFor(
                stream,
                4,
                "collect incremental log lines",
              );
              for (const line of collected) {
                lines.push(line);
              }
              await stream.close();
            } finally {
              await stream.close();
            }

            recordLogLines(lines.length);
            expect(lines).toEqual([
              `${context.marker}-1\n`,
              `${context.marker}-2\n`,
              `${context.marker}-3\n`,
              `${context.marker}-4\n`,
            ]);
            await expectSandboxHealthy(sandbox);
          },
        ),
      );
    },
    stressConfig.timeoutMs,
  );

  it(
    "streams structured entries and raw chunks with cursor metadata",
    async () => {
      await withStressContext(currentClient(), "logs-metadata", async (context) =>
        context.withRunningSandbox(
          [
            "/bin/sh",
            "-lc",
            `printf '${context.marker}-entry\\n'; printf '${context.marker}-raw\\n'; sleep infinity`,
          ],
          async (sandbox) => {
            const entries = await collectWithLimit(
              await sandbox.logs.streamEntries({ tailLines: 2, timestamps: true }),
              2,
            );
            const chunks = await collectWithLimit(
              await sandbox.logs.streamRaw({ tailLines: 2 }),
              2,
            );

            recordLogLines(entries.length);
            recordBytes(chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0));
            expect(entries.map((entry) => entry.line).join("")).toContain(context.marker);
            expect(
              entries.every((entry) => entry.offset !== undefined && entry.sessionId !== undefined),
            ).toBe(true);
            expect(chunks.map((chunk) => chunk.text).join("")).toContain(context.marker);
            expect(chunks.every((chunk) => chunk.data instanceof Uint8Array)).toBe(true);
          },
        ),
      );
    },
    stressConfig.timeoutMs,
  );

  it(
    "handles bounded long log line output",
    async () => {
      await withStressContext(currentClient(), "logs-long-line", async (context) => {
        const targetBytes = stressConfig.limits.streamBytes;

        await context.withRunningSandbox(
          [
            "/bin/sh",
            "-lc",
            `python -c ${JSON.stringify(
              [
                "import sys",
                `marker = ${JSON.stringify(`${context.marker}-`)}`,
                `target = ${targetBytes}`,
                "payload = (marker * ((target // len(marker)) + 1))[:target]",
                "print(payload)",
              ].join("; "),
            )}; sleep infinity`,
          ],
          async (sandbox) => {
            const lines = await context.phase(
              "read long line logs",
              sandbox.logs.read({ tailLines: 1 }),
            );
            const combined = lines.join("");

            recordLogLines(lines.length);
            recordBytes(combined.length);
            expect(combined.length).toBeGreaterThan(16 * 1024);
            expect(combined.length).toBeLessThanOrEqual(targetBytes + 1);
            expect(combined).toContain(context.marker);
          },
        );
      });
    },
    stressConfig.timeoutMs,
  );

  it(
    "opens and closes follow streams repeatedly",
    async () => {
      await withStressContext(currentClient(), "logs-loop", async (context) =>
        context.withRunningSandbox(
          [
            "/bin/sh",
            "-lc",
            `i=0; while true; do i=$((i+1)); printf '${context.marker}-%s\\n' "$i"; sleep 0.2; done`,
          ],
          async (sandbox) => {
            for (let index = 0; index < stressConfig.limits.followLoops; index += 1) {
              const stream = await sandbox.logs.stream({ follow: true });
              try {
                const lines = await collectWithLimit(stream, 1, () => stream.close());
                expect(lines[0]).toContain(context.marker);
              } finally {
                await stream.close();
              }
            }

            await expectSandboxHealthy(sandbox);
          },
        ),
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
