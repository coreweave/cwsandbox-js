// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Prefer direct runner connections with automatic gateway fallback.
 *
 * Pass --direct-only to require the direct path.
 */

import type { DataPlaneMode } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();
  const dataPlaneMode: DataPlaneMode = process.argv.includes("--direct-only") ? "direct" : "auto";
  const sandbox = await client.create({
    dataPlaneMode,
    tags: ["example", "example-direct-data-plane"],
  });

  try {
    const result = await sandbox.commands.run(["python", "-c", "print('runner connected')"]);
    console.log(result.stdout.trimEnd());
  } finally {
    await sandbox.stop({ missingOk: true });
  }
}

await main();
