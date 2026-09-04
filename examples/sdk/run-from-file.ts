// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Create a sandbox from a Compose file.
 *
 * Demonstrates:
 * - withSandboxFromFile() reading a local Compose YAML path
 * - primaryService selecting the sandbox primary
 * - A three-service file (Redis, a Python API, Ubuntu primary) with
 *   healthchecks and depends_on
 *
 * Compose ports stay in-pod; they are not published services. Service
 * hostnames resolve on loopback. YAML is sent as raw bytes; reformatting
 * it changes request identity. Images in this file are already pullable,
 * so imageOverrides is omitted. A leftover build: stanza is not
 * implemented.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

const composePath = join(dirname(fileURLToPath(import.meta.url)), "run-from-file.compose.yaml");
const httpGet = `
set -euo pipefail
exec 3<>/dev/tcp/api/8080
printf 'GET /health HTTP/1.0\\r\\nHost: api\\r\\n\\r\\n' >&3
cat <&3
`;
const redisPing = `
set -euo pipefail
exec 3<>/dev/tcp/cache/6379
printf 'PING\\r\\n' >&3
cat <&3
`;

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  await client.withSandboxFromFile(
    composePath,
    async (sandbox) => {
      console.log(`Sandbox ID: ${sandbox.sandboxId}`);
      const hosts = await sandbox.commands.run(["getent", "hosts", "cache", "api"]);
      console.log(`Hosts:\n${hosts.stdout.trimEnd()}`);

      const ping = await sandbox.commands.run(["bash", "-c", redisPing]);
      console.log(`Redis: ${ping.stdout.trim()}`);

      const health = await sandbox.commands.run(["bash", "-c", httpGet]);
      console.log(`API /health: ${health.stdout.trim()}`);
    },
    {
      defaultResources: {
        limits: { cpu: "500m", memory: "256Mi" },
        requests: { cpu: "500m", memory: "256Mi" },
      },
      primaryService: "main",
      tags: ["example", "example-run-from-file"],
    },
  );
}

await main();
