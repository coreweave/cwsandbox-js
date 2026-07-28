// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Stdin streaming with commands.start({ stdin: true }).
 *
 * Demonstrates writeln(), close() (EOF), and reading the result.
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  await client.withSandbox(
    async (sandbox) => {
      console.log("=== Basic cat roundtrip ===");
      {
        const process = await sandbox.commands.start(["cat"], { stdin: true });
        await process.stdin.write("hello from stdin\n");
        await process.stdin.close();
        const result = await process.wait();
        console.log(`Output: ${result.stdout.trimEnd()}`);
      }

      console.log("\n=== writeln() convenience ===");
      {
        const process = await sandbox.commands.start(["cat"], { stdin: true });
        await process.stdin.writeln("writeline adds a newline");
        await process.stdin.close();
        const result = await process.wait();
        console.log(`Output: ${result.stdout.trimEnd()}`);
      }

      console.log("\n=== Multiple writes ===");
      {
        const process = await sandbox.commands.start(["cat"], { stdin: true });
        for (let i = 0; i < 5; i += 1) {
          await process.stdin.writeln(`line ${i}`);
        }
        await process.stdin.close();
        const result = await process.wait();
        console.log(`Output:\n${result.stdout.trimEnd()}`);
      }

      console.log("\n=== Sort command (needs EOF) ===");
      {
        const process = await sandbox.commands.start(["sort"], { stdin: true });
        await process.stdin.writeln("banana");
        await process.stdin.writeln("apple");
        await process.stdin.writeln("cherry");
        await process.stdin.close();
        const result = await process.wait();
        console.log(`Sorted:\n${result.stdout.trimEnd()}`);
      }
    },
    { tags: ["example", "example-stdin-streaming"] },
  );
}

await main();
