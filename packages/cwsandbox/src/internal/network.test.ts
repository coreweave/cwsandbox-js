// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError } from "../errors.js";
import type { NetworkOptions } from "../public/network.js";
import { normalizeDnsName, validateNetworkOptions } from "./network.js";

describe("normalizeDnsName", () => {
  it("trims and lowercases exact names and wildcards", () => {
    expect(normalizeDnsName("  PyPI.org ")).toBe("pypi.org");
    expect(normalizeDnsName("*.PyPI.org")).toBe("*.pypi.org");
  });

  it("rejects empty and star ceiling names", () => {
    expect(() => normalizeDnsName("   ")).toThrow(/cannot be empty/);
    expect(() => normalizeDnsName("*")).toThrow(/policy ceiling/);
  });

  it.each([
    "*.*.pypi.org",
    "*pypi.org",
    "foo.*.com",
    "pypi.org:443",
    "*.",
    "*example.com",
    "**.example.com",
    "foo.*.example.com",
    "-bad.example.com",
  ])("rejects invalid grammar %s", (name) => {
    expect(() => normalizeDnsName(name)).toThrow(/DNS-1123 subdomain/);
  });
});

describe("validateNetworkOptions ingress", () => {
  it("accepts one source per rule, port ranges, and empty ingress", () => {
    expect(() =>
      validateNetworkOptions(undefined, {
        ingress: [
          { cidr: { cidr: "10.0.0.0/8", exceptCidrs: ["10.1.0.0/16"] }, any: false },
          { ports: [{ endPort: 9010, port: 9000, protocol: "TCP" }], tenant: "same_org" },
          { any: true },
        ],
      }),
    ).not.toThrow();
    expect(() => validateNetworkOptions(undefined, { ingress: [] })).not.toThrow();
  });

  it.each([
    [{}, /exactly one source/],
    [{ any: false }, /exactly one source/],
    [{ any: true, tenant: "same_org" }, /exactly one source/],
    [{ any: "yes" }, /any must be a boolean/],
    [{ cidr: { cidr: "" } }, /cidr\.cidr must be a non-empty string/],
    [{ cidr: "10.0.0.0/8" }, /cidr must be an object/],
    [{ cidr: { cidr: "10.0.0.0/8", exceptCidrs: [""] } }, /exceptCidrs must be an array/],
    [{ tenant: "everyone" }, /tenant must be/],
    [{ tenant: "unspecified" }, /tenant must be/],
    [{ any: true, ports: [{ port: 0 }] }, /ports\[0\]\.port must be an integer/],
    [{ any: true, ports: [{ endPort: 79, port: 80 }] }, /endPort must not be less than port/],
    [{ any: true, ports: [{ endPort: 70000, port: 80 }] }, /endPort must be an integer/],
    [{ any: true, ports: [{ port: 80, protocol: 6 }] }, /protocol must be a string/],
    [{ any: true, ports: 80 }, /ports must be an array/],
  ])("rejects invalid rule %j", (rule, message) => {
    expect(() =>
      validateNetworkOptions(undefined, { ingress: [rule] } as unknown as NetworkOptions),
    ).toThrow(message);
  });

  it("rejects a non-array ingress list", () => {
    expect(() =>
      validateNetworkOptions(undefined, { ingress: { any: true } } as unknown as NetworkOptions),
    ).toThrow(CWSandboxValidationError);
  });
});

describe("validateNetworkOptions egress", () => {
  it("accepts hostname grants and empty egress", () => {
    expect(() =>
      validateNetworkOptions(undefined, {
        egress: [{ dnsName: "pypi.org" }, { dnsName: "*.pypi.org" }],
      }),
    ).not.toThrow();
    expect(() => validateNetworkOptions(undefined, { egress: [] })).not.toThrow();
    expect(() => validateNetworkOptions(undefined, {})).not.toThrow();
  });

  it("rejects denyEgress combined with a non-empty egress list", () => {
    expect(() =>
      validateNetworkOptions(undefined, {
        denyEgress: true,
        egress: [{ dnsName: "pypi.org" }],
      }),
    ).toThrow(CWSandboxValidationError);
    expect(() =>
      validateNetworkOptions(undefined, {
        denyEgress: true,
        egress: [{ dnsName: "pypi.org" }],
      }),
    ).toThrow(/cannot be combined/);
    expect(() => validateNetworkOptions(undefined, { denyEgress: true, egress: [] })).not.toThrow();
  });

  it("rejects a bare string egress list", () => {
    expect(() =>
      validateNetworkOptions(undefined, {
        egress: "pypi.org",
      } as unknown as NetworkOptions),
    ).toThrow(/must be an array of egress rules/);
  });

  it("accepts every destination kind", () => {
    expect(() =>
      validateNetworkOptions(undefined, {
        egress: [
          { dnsName: "pypi.org", ports: [{ port: 443, protocol: "TCP" }] },
          { dnsName: "files.pythonhosted.org", ports: [{ port: 443 }, { port: 443 }] },
          { cidr: { cidr: "10.0.0.0/8", exceptCidrs: ["10.1.0.0/16"] }, ports: [{ port: 5432 }] },
          { tenant: "same_org", ports: [{ endPort: 9000, port: 8000 }] },
          { any: true, ports: [{ port: 53, protocol: "UDP" }] },
          { selector: { namespaceLabels: { team: "a" }, podLabels: { app: "db" } } },
        ],
      }),
    ).not.toThrow();
  });

  it.each<[string, unknown, RegExp]>([
    ["no destination", {}, /exactly one destination/],
    ["two destinations", { any: true, dnsName: "pypi.org" }, /exactly one destination/],
    ["any: false alone", { any: false }, /exactly one destination/],
    ["non-boolean any", { any: "yes" }, /any must be a boolean/],
    ["non-string dnsName", { dnsName: 7 }, /dnsName must be a string/],
    ["hostname on 8443", { dnsName: "pypi.org", ports: [{ port: 8443 }] }, /only TCP 443/],
    [
      "hostname on UDP",
      { dnsName: "pypi.org", ports: [{ port: 443, protocol: "UDP" }] },
      /TCP 443/,
    ],
    ["empty CIDR", { cidr: { cidr: " " } }, /cidr\.cidr must be a non-empty string/],
    ["bare CIDR string", { cidr: "10.0.0.0/8" }, /cidr must be an object/],
    ["unknown tenant", { tenant: "everyone" }, /tenant must be/],
    ["unspecified tenant", { tenant: "unspecified" }, /tenant must be/],
    ["selector without pod labels", { selector: { podLabels: {} } }, /podLabels/],
    ["non-string label", { selector: { podLabels: { app: 1 } } }, /podLabels/],
    ["bad port", { any: true, ports: [{ port: 70000 }] }, /port/],
    ["reversed range", { any: true, ports: [{ endPort: 10, port: 20 }] }, /endPort/],
  ])("rejects an egress rule with %s", (_label, rule, message) => {
    expect(() =>
      validateNetworkOptions(undefined, { egress: [rule] } as unknown as NetworkOptions),
    ).toThrow(message);
  });
});

describe("validateNetworkOptions endpoint requestTimeoutSeconds", () => {
  const publicHttps = {
    endpoint: { auth: "open" as const, kind: "https" as const },
    port: 8080,
    visibility: "public" as const,
  };

  it.each([undefined, 0, 14, 120, 901])("accepts %s", (requestTimeoutSeconds) => {
    expect(() =>
      validateNetworkOptions(
        [
          {
            ...publicHttps,
            ...(requestTimeoutSeconds === undefined
              ? {}
              : { endpoint: { ...publicHttps.endpoint, requestTimeoutSeconds } }),
          },
        ],
        undefined,
      ),
    ).not.toThrow();
  });

  it.each([1.5, Number.NaN, -1])("rejects %s", (requestTimeoutSeconds) => {
    expect(() =>
      validateNetworkOptions(
        [{ ...publicHttps, endpoint: { ...publicHttps.endpoint, requestTimeoutSeconds } }],
        undefined,
      ),
    ).toThrow(/requestTimeoutSeconds must be a non-negative integer/);
  });
});

describe("validateNetworkOptions endpoint auth", () => {
  const publicHttps = {
    port: 8080,
    visibility: "public" as const,
  };

  it("accepts open and share_token", () => {
    expect(() =>
      validateNetworkOptions(
        [{ ...publicHttps, endpoint: { auth: "open", kind: "https" } }],
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      validateNetworkOptions(
        [{ ...publicHttps, endpoint: { auth: "share_token", kind: "https" } }],
        undefined,
      ),
    ).not.toThrow();
  });

  it("rejects unknown auth", () => {
    expect(() =>
      validateNetworkOptions(
        [{ ...publicHttps, endpoint: { auth: "basic", kind: "https" } as never }],
        undefined,
      ),
    ).toThrow(/auth must be open or share_token/);
  });
});

describe("validateNetworkOptions TLS passthrough", () => {
  const publicTls = {
    endpoint: { kind: "tls_passthrough" as const },
    port: 8443,
    visibility: "public" as const,
  };

  it("accepts a public TLS passthrough endpoint", () => {
    expect(() => validateNetworkOptions([publicTls], undefined)).not.toThrow();
  });

  it("rejects auth on a TLS passthrough endpoint", () => {
    expect(() =>
      validateNetworkOptions(
        [
          {
            ...publicTls,
            endpoint: { auth: "open", kind: "tls_passthrough" } as never,
          },
        ],
        undefined,
      ),
    ).toThrow(/auth must be unset when kind is tls_passthrough/);
  });

  it("rejects requestTimeoutSeconds on a TLS passthrough endpoint", () => {
    expect(() =>
      validateNetworkOptions(
        [
          {
            ...publicTls,
            endpoint: { kind: "tls_passthrough", requestTimeoutSeconds: 120 } as never,
          },
        ],
        undefined,
      ),
    ).toThrow(/requestTimeoutSeconds must be unset when kind is tls_passthrough/);
  });

  it("rejects a non-public TLS passthrough endpoint", () => {
    expect(() =>
      validateNetworkOptions([{ ...publicTls, visibility: "private" }], undefined),
    ).toThrow(/visibility must be public/);
  });
});
