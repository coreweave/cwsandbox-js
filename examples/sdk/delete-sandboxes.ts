// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Delete sandboxes by ID and via discovered handles.
 *
 * Demonstrates client.delete(), missingOk, and sandbox.stop() after listAll().
 */

import { CWSandboxNotFoundError } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  console.log("Creating a test sandbox...");
  const sandbox = await client.create({ tags: ["example-delete"] });
  const sandboxId = sandbox.sandboxId;
  console.log(`Created sandbox: ${sandboxId}\n`);

  console.log(`Deleting sandbox ${sandboxId} using client.delete()...`);
  await client.delete(sandboxId);
  console.log("Deletion completed\n");

  console.log("Attempting to delete the same sandbox again...");
  try {
    await client.delete(sandboxId);
  } catch (error) {
    if (error instanceof CWSandboxNotFoundError) {
      console.log(`Expected error: ${error.message}\n`);
    } else {
      throw error;
    }
  }

  console.log("Deleting with missingOk: true...");
  await client.delete(sandboxId, { missingOk: true });
  console.log("Deletion completed (no error even though already deleted)\n");

  console.log("Creating another sandbox to demonstrate stop() on a listed handle...");
  const sandbox2 = await client.create({ tags: ["example-delete-2"] });
  console.log(`Created sandbox: ${sandbox2.sandboxId}`);

  const found = await client.listAll({ tags: ["example-delete-2"] });
  const discovered = found[0];
  if (discovered !== undefined) {
    console.log(`Found sandbox via listAll(): ${discovered.sandboxId}`);
    await discovered.stop({ missingOk: true });
    console.log("Stopped via discovered.stop()\n");
  }

  console.log("Done.");
}

await main();
