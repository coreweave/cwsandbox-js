// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Stream main-process logs from a long-running sandbox command.
 *
 * Demonstrates client.run() + logs.stream({ follow: true }). Streams a few
 * lines then stops (Python's interactive example waits for Ctrl-C / CLI).
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  const entrypoint =
    "echo 'hello' > /tmp/message; i=0; " +
    "while true; do printf '[%d] ' $i; cat /tmp/message; " +
    "i=$((i+1)); sleep 1; done";

  const sandbox = await client.run(["sh", "-c", entrypoint], {
    tags: ["example", "example-interactive-streaming"],
  });

  console.log(`Sandbox running: ${sandbox.sandboxId}`);
  console.log("Streaming logs (first few lines)...\n");

  const logs = await sandbox.logs.stream({ follow: true, timestamps: true });
  try {
    let count = 0;
    for await (const line of logs) {
      process.stdout.write(line);
      count += 1;
      if (count >= 4) {
        await logs.close();
        break;
      }
    }
  } finally {
    await logs.close();
    console.log("\nStopping sandbox...");
    await sandbox.stop({ missingOk: true });
    console.log("Sandbox stopped.");
  }
}

await main();
