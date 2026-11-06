// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * Live smoke for NetworkConfig and `sandbox.updateNetwork`.
 *
 * Opt-in with CWSANDBOX_NETWORK_CONFIG_SMOKE=1: backends without live network
 * updates reject UpdateNetworkConfig. Each test also skips when the sandbox
 * comes back without a `networkConfigId` (backend predates NetworkConfig).
 */

import {
  CWSandboxNetworkConfigInUseError,
  CWSandboxNotFoundError,
  type Sandbox,
  type SandboxClient,
} from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import {
  DNS_EGRESS_EXACT,
  DNS_EGRESS_UNGRANTED,
  DNS_EGRESS_WILD,
  DNS_EGRESS_WILD_HOST,
  dnsEgressSmokeTimeoutMs,
  httpsGetExitCode,
  shouldSkipDnsEgress,
  smokeConfig,
  startOptionsForDnsNameEgress,
  uniqueSmokeTag,
} from "./helpers.js";

const enabled =
  smokeConfig.hasCredentials && process.env["CWSANDBOX_NETWORK_CONFIG_SMOKE"]?.trim() === "1";
const describeWhenEnabled = enabled ? describe : describe.skip;

if (!enabled) {
  console.log(
    "[network-config-smoke] skip: set CWSANDBOX_NETWORK_CONFIG_SMOKE=1 against a backend with live network updates.",
  );
}

describeWhenEnabled("live NetworkConfig smoke", { sequential: true }, () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "grants and revokes hostnames on a running sandbox",
    async (ctx) => {
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await client.create({
          ...startOptionsForDnsNameEgress(),
          network: { egress: [{ dnsName: DNS_EGRESS_EXACT }] },
          tags: [uniqueSmokeTag()],
        });
      } catch (error) {
        if (shouldSkipDnsEgress(error)) {
          ctx.skip(`fleet cannot admit DNS-name egress: ${String(error)}`);
          return;
        }
        throw error;
      }

      try {
        if (sandbox.networkConfigId === undefined) {
          ctx.skip("backend did not bind a NetworkConfig");
          return;
        }
        expect(await httpsGetExitCode(sandbox, `https://${DNS_EGRESS_WILD_HOST}`, 8)).not.toBe(0);

        const widened = await sandbox.updateNetwork({
          egress: [{ dnsName: DNS_EGRESS_EXACT }, { dnsName: DNS_EGRESS_WILD }],
        });
        expect(widened.network.egress).toEqual([
          { dnsName: DNS_EGRESS_EXACT },
          { dnsName: DNS_EGRESS_WILD },
        ]);
        expect(sandbox.dnsEgressNames).toEqual(
          expect.arrayContaining([DNS_EGRESS_EXACT, DNS_EGRESS_WILD]),
        );
        expect(await httpsGetExitCode(sandbox, `https://${DNS_EGRESS_WILD_HOST}`, 20)).toBe(0);
        expect(await httpsGetExitCode(sandbox, `https://${DNS_EGRESS_UNGRANTED}`, 8)).not.toBe(0);

        await sandbox.updateNetwork({ egress: [{ dnsName: DNS_EGRESS_EXACT }] });
        expect(await httpsGetExitCode(sandbox, `https://${DNS_EGRESS_EXACT}`, 20)).toBe(0);
        expect(await httpsGetExitCode(sandbox, `https://${DNS_EGRESS_WILD_HOST}`, 8)).not.toBe(0);
      } finally {
        await sandbox?.delete({ missingOk: true });
      }
    },
    dnsEgressSmokeTimeoutMs,
  );

  it(
    "binds a caller-created config and frees it after the sandbox ends",
    async (ctx) => {
      const networkConfigId = `js-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await client.createNetworkConfig(networkConfigId, { network: { denyIngress: true } });
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await client.create({ networkConfigId, tags: [uniqueSmokeTag()] });
        if (sandbox.networkConfigId === undefined) {
          ctx.skip("backend did not bind the NetworkConfig");
          return;
        }
        expect(sandbox.networkConfigId).toBe(networkConfigId);

        const bound = await client.getNetworkConfig(networkConfigId);
        expect(bound.sandboxId).toBe(sandbox.sandboxId);
        expect(bound.platformManaged).toBe(false);
        await expect(client.deleteNetworkConfig(networkConfigId)).rejects.toBeInstanceOf(
          CWSandboxNetworkConfigInUseError,
        );

        await sandbox.stop();
        sandbox = undefined;
        await client.deleteNetworkConfig(networkConfigId);
        await expect(client.getNetworkConfig(networkConfigId)).rejects.toBeInstanceOf(
          CWSandboxNotFoundError,
        );
      } finally {
        await sandbox?.delete({ missingOk: true });
        await client.deleteNetworkConfig(networkConfigId, { missingOk: true }).catch(() => {
          // Best effort: the config may still be bound while the sandbox winds down.
        });
      }
    },
    dnsEgressSmokeTimeoutMs,
  );
});
