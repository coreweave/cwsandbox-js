// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Multiple sandboxes in parallel (JS has no Session yet — use the client).
 *
 * Demonstrates creating two sandboxes, running commands concurrently, then cleanup.
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();
  const tag = "example-multiple-sandboxes";

  const [sb1, sb2] = await Promise.all([
    client.create({ tags: [tag, "sb1"] }),
    client.create({ tags: [tag, "sb2"] }),
  ]);

  try {
    const [r1, r2] = await Promise.all([
      sb1.commands.run(["sh", "-c", "echo sandbox1 && uname -s"]),
      sb2.commands.run(["sh", "-c", "echo sandbox2 && uname -s"]),
    ]);

    console.log(`sb1 (${sb1.sandboxId}): ${r1.stdout.trim().replaceAll("\n", " | ")}`);
    console.log(`sb2 (${sb2.sandboxId}): ${r2.stdout.trim().replaceAll("\n", " | ")}`);
  } finally {
    await Promise.all([sb1.stop({ missingOk: true }), sb2.stop({ missingOk: true })]);
  }
}

await main();
