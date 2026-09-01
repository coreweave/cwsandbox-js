// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Direct vs gateway data-plane routing.
 *
 * Demonstrates:
 * - Client default `dataPlaneMode: "auto"`
 * - Per-sandbox `gateway` and `direct` overrides
 * - `fromId({ dataPlaneMode })` because create-time mode is not remembered
 */

import { createSandboxClient } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const apiKey = process.env["CWSANDBOX_API_KEY"]?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new Error("CWSANDBOX_API_KEY is required.");
  }

  const client = createSandboxClient({
    apiKey,
    dataPlaneMode: "auto",
  });

  await client.withSandbox(
    async (sandbox) => {
      const result = await sandbox.exec(["echo", "auto-or-fallback"]);
      console.log(result.stdout.trimEnd());
    },
    { tags: ["example", "example-data-plane-mode"] },
  );

  await client.withSandbox(
    async (sandbox) => {
      await sandbox.files.write("/tmp/gateway.txt", "gateway-ok\n");
      console.log((await sandbox.files.readText("/tmp/gateway.txt")).trimEnd());
    },
    { dataPlaneMode: "gateway", tags: ["example", "example-data-plane-mode"] },
  );

  const dedicated = await client.create({
    dataPlaneMode: "direct",
    tags: ["example", "example-data-plane-mode"],
  });
  try {
    const echo = await dedicated.exec(["echo", "direct-mtls"]);
    console.log(echo.stdout.trimEnd());

    const reattached = await client.fromId(dedicated.sandboxId, { dataPlaneMode: "direct" });
    const again = await reattached.exec(["echo", "from-id-direct"]);
    console.log(again.stdout.trimEnd());
  } finally {
    await dedicated.delete({ missingOk: true });
  }
}

await main();
