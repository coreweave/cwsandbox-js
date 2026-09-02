// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Public HTTPS endpoint with an explicit request timeout.
 *
 * Demonstrates:
 * - endpoint.kind "https" on a PUBLIC service
 * - requestTimeoutSeconds (server-side HTTPS clock, not timeoutMs)
 * - inspect().serviceUrls is hostname assignment, not app-ready
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  await client.withSandbox(
    async (sandbox) => {
      const info = await sandbox.inspect();
      const url = info.serviceUrls?.[0]?.url;
      console.log(`Sandbox: ${sandbox.sandboxId}`);
      console.log(`Assigned URL: ${url ?? "(none yet)"}`);
      console.log("Applied timeout is not echoed on serviceUrls.");

      const result = await sandbox.commands.run(["python", "-c", "print('Hello from sandbox!')"]);
      console.log(result.stdout.trimEnd());
    },
    {
      services: [
        {
          endpoint: { auth: "open", kind: "https", requestTimeoutSeconds: 120 },
          name: "http",
          port: 8000,
          visibility: "public",
        },
      ],
      tags: ["example", "example-https-endpoint"],
    },
  );
}

await main();
