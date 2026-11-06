// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { NetworkConfig } from "./generated/coreweave/sandbox/v1/network_config.js";
import {
  DNSEgressMode,
  EgressRule,
  IngressRule,
  NetworkOptions,
  Sandbox as ProtoSandbox,
  SandboxSpec,
  State,
  TenantScope,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import { Timestamp } from "./generated/google/protobuf/timestamp.js";
import {
  toProtoCreateFromTemplateRequest,
  toProtoCreateNetworkConfigRequest,
  toProtoCreateRequest,
  toProtoUpdateNetworkConfigRequest,
  toSdkGetSandboxResult,
  toSdkNetworkConfig,
} from "./mappers.js";

function hostnameRule(name: string, ports: EgressRule["ports"] = []): EgressRule {
  return EgressRule.create({
    destination: { oneofKind: "httpsHostname", httpsHostname: name },
    ports,
  });
}

describe("NetworkConfig mappers", () => {
  it("maps networkConfigId onto create and template requests", () => {
    const create = toProtoCreateRequest({ command: ["sleep"], networkConfigId: "agent-net" });
    expect(create.sandbox?.spec?.networkConfigId).toBe("agent-net");
    expect(create.sandbox?.spec?.network).toBeUndefined();

    const template = toProtoCreateFromTemplateRequest({
      networkConfigId: "agent-net",
      templateId: "tmpl",
    });
    expect(template.overrides?.networkConfigId).toBe("agent-net");
    expect(template.overrides?.network).toBeUndefined();
  });

  it("projects the bound networkConfigId from GET", () => {
    const result = toSdkGetSandboxResult(
      ProtoSandbox.create({
        sandboxId: "sbx",
        spec: SandboxSpec.create({ networkConfigId: "nc-abc" }),
        status: { state: State.RUNNING },
      }),
    );
    expect(result.networkConfigId).toBe("nc-abc");

    const legacy = toSdkGetSandboxResult(
      ProtoSandbox.create({ sandboxId: "sbx", status: { state: State.RUNNING } }),
    );
    expect(legacy).not.toHaveProperty("networkConfigId");
  });

  it("sends an empty spec on create when no rules are given", () => {
    const request = toProtoCreateNetworkConfigRequest({ networkConfigId: "agent-net" });
    expect(request.networkConfig?.networkConfigId).toBe("agent-net");
    expect(request.networkConfig?.spec).toEqual(NetworkOptions.create());
    expect(request.requestId).toBeUndefined();
  });

  it("maps update masks to proto paths and carries the etag", () => {
    const request = toProtoUpdateNetworkConfigRequest({
      etag: "etag-1",
      network: { denyIngress: true, egress: [{ dnsName: " PyPI.org " }] },
      networkConfigId: "agent-net",
      updateMask: ["egress", "denyIngress", "egress"],
    });

    expect(request.networkConfigId).toBe("agent-net");
    expect(request.updateMask?.paths).toEqual(["spec.egress", "spec.deny_ingress"]);
    expect(request.networkConfig?.etag).toBe("etag-1");
    expect(request.networkConfig?.spec?.denyIngress).toBe(true);
    expect(request.networkConfig?.spec?.egress).toEqual([hostnameRule("pypi.org")]);
  });

  it("sends an empty mask as an explicit no-op", () => {
    const request = toProtoUpdateNetworkConfigRequest({
      network: {},
      networkConfigId: "agent-net",
      updateMask: [],
    });
    expect(request.updateMask).toEqual({ paths: [] });
  });

  it("maps a hostname-only config and its status", () => {
    const result = toSdkNetworkConfig(
      NetworkConfig.create({
        etag: "etag-7",
        networkConfigId: "nc-abc",
        spec: NetworkOptions.create({
          denyIngress: true,
          egress: [
            hostnameRule("pypi.org"),
            hostnameRule("*.example.com", [{ endPort: 0, port: 443, protocol: "TCP" }]),
          ],
        }),
        status: {
          createTime: Timestamp.create({ nanos: 0, seconds: "1700000000" }),
          platformManaged: true,
          sandboxId: "sbx",
          updateTime: Timestamp.create({ nanos: 0, seconds: "1700000060" }),
        },
      }),
    );

    expect(result).toEqual({
      createdAt: new Date(1_700_000_000_000),
      etag: "etag-7",
      network: {
        denyIngress: true,
        egress: [{ dnsName: "pypi.org" }, { dnsName: "*.example.com" }],
      },
      networkConfigId: "nc-abc",
      platformManaged: true,
      sandboxId: "sbx",
      unsupportedFields: [],
      updatedAt: new Date(1_700_000_060_000),
    });
  });

  it("maps an empty config with no status", () => {
    expect(toSdkNetworkConfig(NetworkConfig.create({ networkConfigId: "agent-net" }))).toEqual({
      network: {},
      networkConfigId: "agent-net",
      platformManaged: false,
      unsupportedFields: [],
    });
  });

  it.each([
    ["rule with no destination", EgressRule.create()],
    [
      "tenant UNSPECIFIED",
      EgressRule.create({
        destination: { oneofKind: "tenant", tenant: TenantScope.UNSPECIFIED },
      }),
    ],
    [
      "name rule on a non-443 port",
      hostnameRule("pypi.org", [{ endPort: 0, port: 8443, protocol: "TCP" }]),
    ],
    ["name rule on UDP", hostnameRule("pypi.org", [{ endPort: 0, port: 443, protocol: "UDP" }])],
    [
      "name rule with excepts",
      EgressRule.create({
        destination: { oneofKind: "httpsHostname", httpsHostname: "*.example.com" },
        httpsHostnameExcept: ["bad.example.com"],
      }),
    ],
  ])("flags egress it cannot represent (%s) and omits the list", (_label, rule) => {
    const result = toSdkNetworkConfig(
      NetworkConfig.create({
        networkConfigId: "agent-net",
        spec: NetworkOptions.create({ egress: [hostnameRule("pypi.org"), rule] }),
      }),
    );

    expect(result.unsupportedFields).toEqual(["egress"]);
    expect(result.network).toEqual({});
  });

  it("writes every rule kind and reads it back", () => {
    const network = {
      egress: [
        { dnsName: "PyPI.org" },
        { cidr: { cidr: "10.0.0.0/8", exceptCidrs: ["10.1.0.0/16"] }, ports: [{ port: 5432 }] },
        { tenant: "same_org", ports: [{ endPort: 9000, port: 8000, protocol: "TCP" }] },
        { any: true, ports: [{ port: 53, protocol: "UDP" }] },
        { selector: { namespaceLabels: { team: "a" }, podLabels: { app: "db" } } },
        { selector: { podLabels: { app: "cache" } } },
      ],
      ingress: [
        { cidr: { cidr: "203.0.113.0/24" }, ports: [{ port: 8080 }] },
        { tenant: "same_user" },
        { any: true },
      ],
    } as const;

    const request = toProtoCreateNetworkConfigRequest({ network, networkConfigId: "agent-net" });
    const spec = request.networkConfig?.spec;
    expect(spec?.egress.map((rule) => rule.destination.oneofKind)).toEqual([
      "httpsHostname",
      "cidr",
      "tenant",
      "any",
      "selector",
      "selector",
    ]);
    expect(spec?.egress[0]?.destination).toEqual({
      httpsHostname: "pypi.org",
      oneofKind: "httpsHostname",
    });
    expect(spec?.egress[1]).toMatchObject({
      destination: { cidr: { cidr: "10.0.0.0/8", except: ["10.1.0.0/16"] } },
      ports: [{ endPort: 0, port: 5432, protocol: "" }],
    });
    expect(spec?.egress[2]?.destination).toEqual({
      oneofKind: "tenant",
      tenant: TenantScope.SAME_ORG,
    });

    const result = toSdkNetworkConfig(
      NetworkConfig.create({ networkConfigId: "agent-net", spec: spec ?? NetworkOptions.create() }),
    );
    expect(result.unsupportedFields).toEqual([]);
    expect(result.network).toEqual({
      ...network,
      egress: [{ dnsName: "pypi.org" }, ...network.egress.slice(1)],
    });
  });

  it("reads a hostname rule that lists TCP 443 more than once", () => {
    const result = toSdkNetworkConfig(
      NetworkConfig.create({
        networkConfigId: "agent-net",
        spec: NetworkOptions.create({
          egress: [
            hostnameRule("pypi.org", [
              { endPort: 0, port: 443, protocol: "TCP" },
              { endPort: 443, port: 443, protocol: "tcp" },
            ]),
          ],
        }),
      }),
    );
    expect(result.unsupportedFields).toEqual([]);
    expect(result.network).toEqual({ egress: [{ dnsName: "pypi.org" }] });
  });

  it("writes ingress as spec.ingress on update", () => {
    const request = toProtoUpdateNetworkConfigRequest({
      network: { ingress: [{ tenant: "same_org" }] },
      networkConfigId: "agent-net",
      updateMask: ["ingress"],
    });
    expect(request.updateMask?.paths).toEqual(["spec.ingress"]);
    expect(request.networkConfig?.spec?.ingress[0]?.source).toEqual({
      oneofKind: "tenant",
      tenant: TenantScope.SAME_ORG,
    });
  });

  it("flags ingress rules and maps the DNS egress mode", () => {
    const result = toSdkNetworkConfig(
      NetworkConfig.create({
        networkConfigId: "agent-net",
        spec: NetworkOptions.create({
          dnsEgress: DNSEgressMode.DNS_EGRESS_MODE_DENY,
          egress: [hostnameRule("pypi.org")],
          ingress: [IngressRule.create()],
        }),
      }),
    );

    expect(result.unsupportedFields).toEqual(["ingress"]);
    expect(result.network).toEqual({ dnsEgress: "deny", egress: [{ dnsName: "pypi.org" }] });
  });

  it("sends dnsEgress on create and as spec.dns_egress on update", () => {
    const create = toProtoCreateRequest({ command: ["sleep"], network: { dnsEgress: "deny" } });
    expect(create.sandbox?.spec?.network?.dnsEgress).toBe(DNSEgressMode.DNS_EGRESS_MODE_DENY);

    const update = toProtoUpdateNetworkConfigRequest({
      network: { dnsEgress: "allow" },
      networkConfigId: "agent-net",
      updateMask: ["dnsEgress"],
    });
    expect(update.networkConfig?.spec?.dnsEgress).toBe(DNSEgressMode.DNS_EGRESS_MODE_ALLOW);
    expect(update.updateMask?.paths).toEqual(["spec.dns_egress"]);

    const reset = toProtoUpdateNetworkConfigRequest({
      network: {},
      networkConfigId: "agent-net",
      updateMask: ["dnsEgress"],
    });
    expect(reset.networkConfig?.spec?.dnsEgress).toBe(DNSEgressMode.DNS_EGRESS_MODE_UNSPECIFIED);
  });

  it("projects the effective DNS egress mode from GET", () => {
    const result = toSdkGetSandboxResult(
      ProtoSandbox.create({
        sandboxId: "sbx",
        status: { effectiveDnsEgress: DNSEgressMode.DNS_EGRESS_MODE_DENY, state: State.RUNNING },
      }),
    );
    expect(result.effectiveDnsEgress).toBe("deny");

    const unreported = toSdkGetSandboxResult(
      ProtoSandbox.create({ sandboxId: "sbx", status: { state: State.RUNNING } }),
    );
    expect(unreported.effectiveDnsEgress).toBeUndefined();
  });
});
