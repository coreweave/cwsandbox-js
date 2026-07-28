// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Clean up sandboxes by tag.
 *
 * Usage:
 *   pnpm --dir examples/sdk cleanup-by-tag -- --create
 *   pnpm --dir examples/sdk cleanup-by-tag -- --cleanup
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

const TAG = "example-cleanup-by-tag";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function createTaggedSandboxes(count: number): Promise<void> {
  const client = createSandboxClientFromEnv();
  console.log(`Creating ${count} sandboxes with tag '${TAG}'...`);

  const sandboxes = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      client.create({ tags: [TAG, `instance-${i}`], waitUntilRunning: false }),
    ),
  );

  for (const sandbox of sandboxes) {
    console.log(`  Created: ${sandbox.sandboxId}`);
  }

  console.log(`\nCreated ${sandboxes.length} sandboxes`);
  console.log("Run with --cleanup to delete them.");
}

async function cleanupTaggedSandboxes(): Promise<void> {
  const client = createSandboxClientFromEnv();
  console.log(`Finding sandboxes with tag '${TAG}'...`);

  const sandboxes = await client.listAll({ tags: [TAG] });
  console.log(`Found ${sandboxes.length} sandbox(es)`);

  if (sandboxes.length === 0) {
    console.log("\nNothing to clean up.");
    return;
  }

  for (const sandbox of sandboxes) {
    console.log(`  ${sandbox.sandboxId} (status: ${sandbox.status ?? "unknown"})`);
  }

  console.log("\nDeleting sandboxes...");
  await Promise.all(sandboxes.map((sandbox) => sandbox.delete({ missingOk: true })));
  console.log("Cleanup complete.");
}

async function main(): Promise<void> {
  if (hasFlag("--create")) {
    await createTaggedSandboxes(3);
    return;
  }
  if (hasFlag("--cleanup")) {
    await cleanupTaggedSandboxes();
    return;
  }

  console.error("Usage: --create | --cleanup");
  process.exitCode = 1;
}

await main();
