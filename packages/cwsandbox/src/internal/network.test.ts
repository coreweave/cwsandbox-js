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
    ).toThrow(/sequence of \{ dnsName: string \}/);
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
