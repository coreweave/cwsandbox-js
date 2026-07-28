// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Error handling patterns.
 *
 * Demonstrates:
 * - CWSandboxExecutionError with check: true
 * - CWSandboxNotFoundError with missingOk
 */

import { CWSandboxExecutionError, CWSandboxNotFoundError } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  console.log("1. CWSandboxExecutionError with check: true");
  console.log("-".repeat(50));

  await client.withSandbox(
    async (sandbox) => {
      const result = await sandbox.commands.run(["sh", "-c", "exit 42"]);
      console.log(`   Without check: exitCode=${result.exitCode} (no exception)`);

      try {
        await sandbox.commands.run(["sh", "-c", "exit 1"], { check: true });
      } catch (error) {
        if (error instanceof CWSandboxExecutionError) {
          console.log("   With check: true: caught CWSandboxExecutionError");
          console.log(`   exitCode=${error.result?.exitCode}`);
        } else {
          throw error;
        }
      }
    },
    { tags: ["example", "example-error-handling"] },
  );
  console.log();

  console.log("2. CWSandboxNotFoundError with missingOk");
  console.log("-".repeat(50));

  const fakeId = "non-existent-sandbox-id";
  try {
    await client.delete(fakeId);
  } catch (error) {
    if (error instanceof CWSandboxNotFoundError) {
      console.log("   Without missingOk: caught CWSandboxNotFoundError");
      console.log(`   sandboxId=${error.sandboxId ?? fakeId}`);
    } else {
      throw error;
    }
  }

  await client.delete(fakeId, { missingOk: true });
  console.log("   With missingOk: true: delete completed (no exception)");
  console.log();

  console.log("All error handling patterns demonstrated!");
}

await main();
