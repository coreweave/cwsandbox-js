// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { spawn } from "node:child_process";

const args = process.argv.slice(2);

if (args.includes("--cleanup")) {
  await run("tsx", [
    "scripts/cleanup-stress-sandboxes.ts",
    ...args.filter((arg) => arg !== "--cleanup"),
  ]);
} else {
  await run("vitest", [
    "run",
    "--config",
    "vitest.stress.config.ts",
    ...(args.includes("--heavy") ? ["--mode", "heavy"] : []),
  ]);
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: true,
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "unknown"}`));
    });
    child.on("error", reject);
  });
}
