// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Basic sandbox execution: commands plus file read/write.
 *
 * Demonstrates:
 * - withSandbox() for automatic cleanup
 * - commands.run()
 * - files.write / files.readText
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  await client.withSandbox(
    async (sandbox) => {
      console.log(`Sandbox started: ${sandbox.sandboxId}`);
      console.log(`Running on runner: ${sandbox.runnerId ?? "(pending)"}`);
      console.log(`Sandbox status: ${sandbox.status ?? "(unknown)"}`);

      const echo = await sandbox.commands.run(["echo", "Hello from CWSandbox"]);
      console.log(echo.stdout.trimEnd());

      await sandbox.files.write("/tmp/data.txt", "Hello, World!\n");
      console.log("write: '/tmp/data.txt'");

      const text = await sandbox.files.readText("/tmp/data.txt");
      console.log(`readText content=${text.trimEnd()}`);

      const cat = await sandbox.commands.run(["cat", "/tmp/data.txt"]);
      console.log(`cat /tmp/data.txt -> ${cat.stdout.trimEnd()}`);
    },
    {
      tags: ["example", "example-basic-execution"],
    },
  );
}

await main();
