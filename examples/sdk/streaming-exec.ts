// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Streaming command execution with real-time stdout.
 *
 * Demonstrates iterating process.stdout as chunks arrive, then wait().
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  await client.withSandbox(
    async (sandbox) => {
      console.log("=== Real-time stdout iteration ===");
      const cmd = [
        "python",
        "-c",
        [
          "import time",
          "for i in range(5):",
          "    print(f'Line {i}', flush=True)",
          "    time.sleep(0.3)",
        ].join("\n"),
      ] as const;

      const process = await sandbox.commands.start(cmd);

      for await (const chunk of process.stdout) {
        console.log(`Received: ${chunk.trimEnd()}`);
      }

      const result = await process.wait();
      console.log(`Exit code: ${result.exitCode}`);
    },
    { tags: ["example", "example-streaming-exec"] },
  );
}

await main();
