// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Resource configuration: flat (guaranteed) and requests/limits (burstable).
 *
 * GPU examples are omitted here so the script stays runnable without GPU quota.
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  console.log("=== Burstable QoS (requests/limits) ===");
  await client.withSandbox(
    async (sandbox) => {
      console.log(`Sandbox: ${sandbox.sandboxId}`);
      console.log(`Requests: ${JSON.stringify(sandbox.resourceRequests)}`);
      console.log(`Limits:   ${JSON.stringify(sandbox.resourceLimits)}`);
      const result = await sandbox.commands.run([
        "python3",
        "-c",
        "import os; print(os.cpu_count(), 'CPUs')",
      ]);
      console.log(`Output:   ${result.stdout.trimEnd()}`);
    },
    {
      resources: {
        requests: { cpu: "500m", memory: "512Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      },
      tags: ["example", "example-resource-configuration"],
    },
  );

  console.log("\n=== Guaranteed QoS (flat resources) ===");
  await client.withSandbox(
    async (sandbox) => {
      console.log(`Sandbox: ${sandbox.sandboxId}`);
      console.log(`Requests: ${JSON.stringify(sandbox.resourceRequests)}`);
      console.log(`Limits:   ${JSON.stringify(sandbox.resourceLimits)}`);
    },
    {
      resources: { cpu: "1", memory: "1Gi" },
      tags: ["example", "example-resource-configuration"],
    },
  );
}

await main();
