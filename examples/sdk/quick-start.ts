// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Quick start — the most common sandbox usage pattern.
 *
 * Demonstrates:
 * - withSandbox() for automatic cleanup
 * - Running commands with commands.run()
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  const result = await client.withSandbox(
    async (sandbox) => {
      console.log(`Sandbox ID: ${sandbox.sandboxId}`);
      return sandbox.commands.run(["python", "-c", "print('Hello from sandbox!')"]);
    },
    { tags: ["example-quick-start"] },
  );

  console.log(`Output: ${result.stdout.trim()}`);
  console.log(`Exit code: ${result.exitCode}`);
}

await main();
