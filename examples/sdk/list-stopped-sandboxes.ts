// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * List sandboxes including stopped (terminal) ones.
 *
 * Usage:
 *   pnpm --dir examples/sdk list-stopped-sandboxes -- --create
 *   pnpm --dir examples/sdk list-stopped-sandboxes -- --list
 *   pnpm --dir examples/sdk list-stopped-sandboxes -- --list --include-stopped
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

const TAG = "example-list-stopped";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function createSandboxes(count: number): Promise<void> {
  const client = createSandboxClientFromEnv();
  console.log(`Creating ${count} short-lived sandboxes with tag '${TAG}'...`);

  await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      // Fire-and-wait-for-terminal: short-lived mains can finish before a
      // running-status poll, so do not waitUntilRunning.
      const sandbox = await client.run(["echo", `hello-${i}`], {
        tags: [TAG, `instance-${i}`],
        waitUntilRunning: false,
      });
      await sandbox.wait({ targetStatus: "terminal", timeoutMs: 120_000 });
      console.log(`  ${sandbox.sandboxId} -> ${sandbox.status}`);
    }),
  );

  console.log("\nCreated and waited for terminal status.");
  console.log("List with --list, or include terminals with --list --include-stopped.");
}

async function listSandboxes(includeStopped: boolean): Promise<void> {
  const client = createSandboxClientFromEnv();
  console.log(`Listing sandboxes with tag '${TAG}' (includeStopped=${includeStopped})...`);

  const sandboxes = await client.listAll({
    tags: [TAG],
    includeStopped,
  });

  console.log(`Found ${sandboxes.length}`);
  for (const sandbox of sandboxes) {
    console.log(`  ${sandbox.sandboxId} status=${sandbox.status ?? "unknown"}`);
  }
}

async function main(): Promise<void> {
  if (hasFlag("--create")) {
    await createSandboxes(2);
    return;
  }
  if (hasFlag("--list")) {
    await listSandboxes(hasFlag("--include-stopped"));
    return;
  }

  console.error("Usage: --create | --list [--include-stopped]");
  process.exitCode = 1;
}

await main();
