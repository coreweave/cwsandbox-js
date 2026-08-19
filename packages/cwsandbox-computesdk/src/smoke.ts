// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * End-to-end smoke test against the live CoreWeave Sandbox API via ComputeSDK.
 *
 * Requires CWSANDBOX_API_KEY and creates a real (billable) sandbox; it is
 * always destroyed on exit. Not part of `pnpm check`.
 *
 * Run with: pnpm --filter @coreweave/cwsandbox-computesdk smoke
 */

import { coreweave } from "./index.js";

async function main(): Promise<void> {
  const compute = coreweave({});
  console.log("creating sandbox (1 cpu / 2Gi, lifetime 900s)...");
  const t0 = Date.now();
  const sandbox = await compute.sandbox.create({
    cpu: 1,
    memoryMiB: 2048,
    maxLifetimeSeconds: 900,
    name: "adapter-smoke",
    services: [
      {
        endpoint: { auth: "open", kind: "https" },
        name: "http",
        port: 8000,
        visibility: "public",
      },
    ],
  });
  console.log(`created ${sandbox.sandboxId} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  try {
    // 1. Short/unary path
    let r = await sandbox.runCommand("echo hello-from-coreweave && uname -r && nproc");
    console.log(`[unary] exit=${r.exitCode} ${r.durationMs}ms stdout=${JSON.stringify(r.stdout)}`);
    if (r.exitCode !== 0 || !r.stdout.includes("hello-from-coreweave")) {
      throw new Error("unary exec failed");
    }

    // 2. cwd + env options
    r = await sandbox.runCommand('pwd && echo "V=$SMOKE_VAR"', {
      cwd: "/tmp",
      env: { SMOKE_VAR: "ok" },
    });
    console.log(`[opts]  exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)}`);
    if (!r.stdout.includes("/tmp") || !r.stdout.includes("V=ok")) {
      throw new Error("cwd/env failed");
    }

    // 3. Long-timeout path (timeout > 240s forces commands.start); command runs ~9s
    r = await sandbox.runCommand(
      'echo start; for i in 1 2 3; do sleep 3; echo "tick $i"; done; echo "to-stderr" >&2; exit 7',
      { timeout: 400_000 },
    );
    console.log(
      `[long] exit=${r.exitCode} ${r.durationMs}ms stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
    );
    if (r.exitCode !== 7 || !r.stdout.includes("tick 3") || !r.stderr.includes("to-stderr")) {
      throw new Error("long-timeout exec failed");
    }

    // 4. Filesystem roundtrip (writeFile creates parent dirs)
    await sandbox.filesystem.writeFile(
      "/tmp/smoke/nested/hello.txt",
      "roundtrip ✓ with 'quotes' and $vars",
    );
    const content = await sandbox.filesystem.readFile("/tmp/smoke/nested/hello.txt");
    console.log(`[fs] readback=${JSON.stringify(content)}`);
    if (!content.includes("roundtrip ✓")) {
      throw new Error("filesystem roundtrip failed");
    }
    const entries = await sandbox.filesystem.readdir("/tmp/smoke/nested");
    console.log(`[fs] readdir=${JSON.stringify(entries)}`);
    if (!entries.some((entry) => entry.name === "hello.txt")) {
      throw new Error("filesystem readdir missing hello.txt");
    }

    // 5. getInfo
    const info = await sandbox.getInfo();
    console.log(`[info] status=${info.status} runner=${info.metadata?.["runnerId"] ?? ""}`);
    if (info.status !== "running" || info.id !== sandbox.sandboxId) {
      throw new Error(`getInfo unexpected: status=${info.status} id=${info.id}`);
    }

    // 6. Public HTTPS assignment (polls inspect until the hostname appears)
    const url = await sandbox.getUrl({ port: 8000 });
    console.log(`[url] ${url}`);
    if (!url.startsWith("https://")) {
      throw new Error(`getUrl unexpected: ${url}`);
    }

    console.log("ALL SMOKE TESTS PASSED");
  } finally {
    const td = Date.now();
    await sandbox.destroy();
    console.log(`destroyed in ${((Date.now() - td) / 1000).toFixed(1)}s`);
  }
}

main().catch((err: unknown) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
