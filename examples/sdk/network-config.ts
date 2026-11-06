// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Change a running sandbox's network rules without recreating it.
 *
 * Demonstrates:
 * - sandbox.updateNetwork to grant an HTTPS hostname live
 * - a caller-created NetworkConfig bound with networkConfigId, reused after
 *   the sandbox ends
 * - etag-guarded update and CWSandboxEtagMismatchError
 *
 * Needs a backend with live network updates; older backends return no
 * networkConfigId on the sandbox.
 */

import { CWSandboxEtagMismatchError } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  // 1. Backend-created config: grant a hostname on a running sandbox.
  await client.withSandbox(
    ["sleep", "infinity"],
    async (sandbox) => {
      if (sandbox.networkConfigId === undefined) {
        throw new Error("Backend does not support NetworkConfig; no networkConfigId on sandbox.");
      }
      console.log(`Sandbox ${sandbox.sandboxId} uses ${sandbox.networkConfigId}`);

      await sandbox.updateNetwork({ egress: [{ dnsName: "pypi.org" }] });
      console.log(`Granted: ${String(sandbox.dnsEgressNames)}`);
    },
    {
      network: { egress: [{ dnsName: "github.com" }] },
      tags: ["example", "example-network-config"],
    },
  );

  // 2. Caller-created config: survives the sandbox and can be reused.
  const networkConfigId = `example-${Date.now().toString(36)}`;
  await client.createNetworkConfig(networkConfigId, {
    network: { egress: [{ dnsName: "github.com" }] },
  });
  try {
    await client.withSandbox(
      ["sleep", "infinity"],
      async () => {
        const current = await client.getNetworkConfig(networkConfigId);
        try {
          await client.updateNetworkConfig(
            networkConfigId,
            { denyIngress: true },
            current.etag === undefined ? {} : { etag: current.etag },
          );
        } catch (error) {
          if (error instanceof CWSandboxEtagMismatchError) {
            console.log("Config changed since it was read; read it again and retry.");
            return;
          }
          throw error;
        }
        console.log(`Updated ${networkConfigId}`);
      },
      { networkConfigId, tags: ["example", "example-network-config"] },
    );
  } finally {
    await client.deleteNetworkConfig(networkConfigId, { missingOk: true });
  }
}

await main();
