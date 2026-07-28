// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * Thin live smoke for the ComputeSDK adapter.
 *
 * Requires CWSANDBOX_API_KEY. Not part of `pnpm check`.
 */

import { coreweave } from "./index.js";

async function main(): Promise<void> {
  const compute = coreweave({});
  const sandbox = await compute.sandbox.create({
    image: "ubuntu:24.04",
  });

  console.log(`created ${sandbox.sandboxId}`);

  try {
    const result = await sandbox.runCommand("echo smoke-ok && uname -s");
    if (result.exitCode !== 0) {
      throw new Error(`command failed: ${result.stderr || result.stdout}`);
    }
    console.log(result.stdout.trimEnd());

    await sandbox.filesystem.writeFile("/tmp/cwsandbox-computesdk-smoke.txt", "hello");
    const text = await sandbox.filesystem.readFile("/tmp/cwsandbox-computesdk-smoke.txt");
    if (text !== "hello") {
      throw new Error(`unexpected file contents: ${text}`);
    }
    console.log("filesystem ok");
  } finally {
    await sandbox.destroy();
    console.log("destroyed");
  }
}

await main();
