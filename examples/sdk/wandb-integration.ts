// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * W&B gateway auth via @coreweave/cwsandbox/wandb.
 *
 * Demonstrates createSandboxClientFromEnv() on the W&B subpath (API key / netrc).
 * For Weave tracing of sandbox work, see examples/weave.
 *
 * Prerequisites:
 *   export WANDB_API_KEY=...
 *   # optional: WANDB_ENTITY, WANDB_PROJECT, WANDB_SANDBOX_BASE_URL
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/wandb";

async function main(): Promise<void> {
  console.log("W&B Sandbox Gateway Example");
  console.log("=".repeat(50));

  const client = createSandboxClientFromEnv();

  const result = await client.withSandbox(
    async (sandbox) => {
      console.log(`Sandbox ID: ${sandbox.sandboxId}`);
      return sandbox.commands.run([
        "python",
        "-c",
        "print('hello from wandb-authenticated sandbox')",
      ]);
    },
    { tags: ["example", "example-wandb-integration"] },
  );

  console.log(`stdout: ${result.stdout.trimEnd()}`);
  console.log(`exitCode: ${result.exitCode}`);
  console.log("Done.");
}

await main();
