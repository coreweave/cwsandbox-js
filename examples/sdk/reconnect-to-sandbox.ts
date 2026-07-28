// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Reconnect to an existing sandbox by ID.
 *
 * Usage:
 *   pnpm --dir examples/sdk reconnect-to-sandbox -- --create
 *   pnpm --dir examples/sdk reconnect-to-sandbox -- --sandbox-id <id>
 *   pnpm --dir examples/sdk reconnect-to-sandbox -- --sandbox-id <id> --stop
 */

import { CWSandboxNotFoundError } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function createLongRunningSandbox(): Promise<string> {
  const client = createSandboxClientFromEnv();
  console.log("Creating a long-running sandbox...");
  const sandbox = await client.create({ tags: ["example-reconnect"] });
  console.log(`Created sandbox: ${sandbox.sandboxId}`);
  console.log(`Runner: ${sandbox.runnerId ?? "(pending)"}`);
  console.log(`Status: ${sandbox.status ?? "(unknown)"}`);
  console.log();
  console.log("This sandbox will keep running until you stop it.");
  console.log("To reconnect later, run:");
  console.log(
    `  pnpm --dir examples/sdk reconnect-to-sandbox -- --sandbox-id ${sandbox.sandboxId}`,
  );
  console.log();
  console.log("To stop it:");
  console.log(
    `  pnpm --dir examples/sdk reconnect-to-sandbox -- --sandbox-id ${sandbox.sandboxId} --stop`,
  );
  return sandbox.sandboxId;
}

async function reconnectToSandbox(sandboxId: string, stop: boolean): Promise<void> {
  const client = createSandboxClientFromEnv();
  console.log(`Reconnecting to sandbox: ${sandboxId}`);

  try {
    const sandbox = await client.fromId(sandboxId);
    console.log("Connected!");
    console.log(`  Status: ${sandbox.status ?? "(unknown)"}`);
    console.log(`  Runner: ${sandbox.runnerId ?? "(unknown)"}`);
    console.log(`  Started at: ${sandbox.startedAt?.toISOString() ?? "(unknown)"}`);
    console.log();

    const result = await sandbox.commands.run(["echo", "hello from reconnect"]);
    console.log(`Command output: ${result.stdout.trimEnd()}`);

    if (stop) {
      console.log("Stopping sandbox...");
      await sandbox.stop({ missingOk: true });
      console.log("Stopped.");
    }
  } catch (error) {
    if (error instanceof CWSandboxNotFoundError) {
      console.error(`Error: Sandbox ${sandboxId} not found`);
      console.error("It may have been stopped or never existed.");
      return;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  if (hasFlag("--create")) {
    await createLongRunningSandbox();
    return;
  }

  const sandboxId = getArg("--sandbox-id");
  if (sandboxId === undefined || sandboxId === "") {
    console.error("Usage:");
    console.error("  --create");
    console.error("  --sandbox-id <id> [--stop]");
    process.exitCode = 1;
    return;
  }

  await reconnectToSandbox(sandboxId, hasFlag("--stop"));
}

await main();
