// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Stop sandboxes older than a threshold (client-side filter on startedAt).
 *
 * Usage:
 *   pnpm --dir examples/sdk cleanup-old-sandboxes -- --dry-run
 *   pnpm --dir examples/sdk cleanup-old-sandboxes -- --max-age-hours 2
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const dryRun = hasFlag("--dry-run");
  const maxAgeHours = Number(getArg("--max-age-hours") ?? "2");
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    console.error("--max-age-hours must be a positive number");
    process.exitCode = 1;
    return;
  }

  const client = createSandboxClientFromEnv();
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

  const sandboxes = await client.listAll({ status: "running" });
  const old = sandboxes.filter((sandbox) => {
    const started = sandbox.startedAt?.getTime();
    return started !== undefined && started < cutoff;
  });

  console.log(`Running sandboxes: ${sandboxes.length}`);
  console.log(`Older than ${maxAgeHours}h: ${old.length}`);

  if (old.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  for (const sandbox of old) {
    console.log(
      `  ${sandbox.sandboxId} startedAt=${sandbox.startedAt?.toISOString() ?? "unknown"}`,
    );
  }

  if (dryRun) {
    console.log("\nDry run — no sandboxes stopped.");
    return;
  }

  let stopped = 0;
  let failed = 0;
  for (const sandbox of old) {
    try {
      await sandbox.stop({ missingOk: true });
      stopped += 1;
    } catch (error) {
      failed += 1;
      console.error(`Failed to stop ${sandbox.sandboxId}:`, error);
    }
  }

  console.log(`\nStopped: ${stopped}, failed: ${failed}`);
}

await main();
