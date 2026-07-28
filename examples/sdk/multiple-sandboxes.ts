// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Multiple sandboxes in parallel (JS has no Session yet — use withSandbox).
 *
 * Demonstrates creating two sandboxes, running commands concurrently, then
 * per-sandbox cleanup so a failed peer cannot leak a billable sandbox.
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();
  const tag = "example-multiple-sandboxes";

  const [r1, r2] = await Promise.all([
    client.withSandbox(
      async (sb1) => {
        const result = await sb1.commands.run(["sh", "-c", "echo sandbox1 && uname -s"]);
        return { sandboxId: sb1.sandboxId, result };
      },
      { tags: [tag, "sb1"] },
    ),
    client.withSandbox(
      async (sb2) => {
        const result = await sb2.commands.run(["sh", "-c", "echo sandbox2 && uname -s"]);
        return { sandboxId: sb2.sandboxId, result };
      },
      { tags: [tag, "sb2"] },
    ),
  ]);

  console.log(`sb1 (${r1.sandboxId}): ${r1.result.stdout.trim().replaceAll("\n", " | ")}`);
  console.log(`sb2 (${r2.sandboxId}): ${r2.result.stdout.trim().replaceAll("\n", " | ")}`);
}

await main();
