// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * Live smoke for NetworkConfig and `sandbox.updateNetwork`.
 *
 * Opt-in with CWSANDBOX_NETWORK_CONFIG_SMOKE=1: backends without live network
 * updates reject UpdateNetworkConfig. The sandbox tests also skip when the
 * sandbox comes back without a `networkConfigId` (backend predates
 * NetworkConfig), and the live ingress test skips when policy forbids its rule.
 */

import {
  CWSandboxNetworkConfigInUseError,
  CWSandboxNotFoundError,
  CWSandboxTransportError,
  type EgressRule,
  type IngressRule,
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

// One rule of every kind. An unbound config gets only syntax checks, not the
// policy ceiling, so the backend should store all of them as written.
const EVERY_EGRESS_RULE: readonly EgressRule[] = [
  { dnsName: "pypi.org" },
  { dnsName: "*.pythonhosted.org", ports: [{ port: 443, protocol: "TCP" }] },
  {
    cidr: { cidr: "10.0.0.0/8", exceptCidrs: ["10.1.0.0/16"] },
    ports: [{ port: 5432, protocol: "TCP" }],
  },
  { tenant: "same_org", ports: [{ endPort: 9000, port: 8000, protocol: "TCP" }] },
  { tenant: "same_user" },
  { any: true, ports: [{ port: 53, protocol: "UDP" }] },
  { selector: { namespaceLabels: { team: "smoke" }, podLabels: { app: "db" } } },
];
const EVERY_INGRESS_RULE: readonly IngressRule[] = [
  { cidr: { cidr: "203.0.113.0/24" }, ports: [{ port: 8080, protocol: "TCP" }] },
  { tenant: "same_org" },
  { any: true, ports: [{ port: 9000, protocol: "SCTP" }] },
];

function smokeNetworkConfigId(): string {
  return `js-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function exceedsPolicy(error: unknown): boolean {
  return (
    error instanceof CWSandboxTransportError &&
    error.reason === "CWSANDBOX_RESOURCE_CEILING_EXCEEDED"
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
      const networkConfigId = smokeNetworkConfigId();
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

  it("stores and reads back every egress and ingress rule type", async () => {
    const networkConfigId = smokeNetworkConfigId();
    const network = { egress: EVERY_EGRESS_RULE, ingress: EVERY_INGRESS_RULE };
    try {
      // The SDK reads a hostname rule's TCP 443 ports back as a plain hostname rule.
      const stored = {
        egress: EVERY_EGRESS_RULE.map((rule) =>
          rule.dnsName === undefined ? rule : { dnsName: rule.dnsName },
        ),
        ingress: EVERY_INGRESS_RULE,
      };
      const created = await client.createNetworkConfig(networkConfigId, { network });
      expect(created.unsupportedFields).toEqual([]);
      expect(created.network).toEqual(stored);

      const fetched = await client.getNetworkConfig(networkConfigId);
      expect(fetched.unsupportedFields).toEqual([]);
      expect(fetched.network).toEqual(stored);

      const narrowed = await client.updateNetworkConfig(
        networkConfigId,
        { ingress: [{ tenant: "same_user" }] },
        { updateMask: ["ingress"] },
      );
      expect(narrowed.network).toEqual({ ...stored, ingress: [{ tenant: "same_user" }] });
    } finally {
      await client.deleteNetworkConfig(networkConfigId, { missingOk: true });
    }
  });

  it(
    "reports effective ingress after a live update",
    async (ctx) => {
      // Declared ingress only applies to CUSTOM-visibility ports, so expose one.
      let sandbox: Sandbox;
      try {
        sandbox = await client.create({
          maxLifetimeSeconds: 300,
          services: [{ port: 8080, visibility: "custom" }],
          tags: [uniqueSmokeTag()],
        });
      } catch (error) {
        if (shouldSkipDnsEgress(error)) {
          ctx.skip(`fleet cannot place a sandbox with a CUSTOM port: ${String(error)}`);
          return;
        }
        throw error;
      }
      try {
        if (sandbox.networkConfigId === undefined) {
          ctx.skip("backend did not bind a NetworkConfig");
          return;
        }
        const rule: IngressRule = { tenant: "same_org", ports: [{ port: 8080, protocol: "TCP" }] };
        try {
          const updated = await sandbox.updateNetwork({ ingress: [rule] });
          expect(updated.network.ingress).toEqual([rule]);
        } catch (error) {
          if (exceedsPolicy(error)) {
            ctx.skip(`policy does not allow same-org ingress: ${String(error)}`);
            return;
          }
          throw error;
        }
        // The policy may add its own rules, so look for ours rather than an exact list.
        expect(sandbox.effectiveIngress).toContainEqual(rule);

        await sandbox.inspect();
        expect(sandbox.effectiveIngress).toContainEqual(rule);
      } finally {
        await sandbox.delete({ missingOk: true });
      }
    },
    dnsEgressSmokeTimeoutMs,
  );
});
