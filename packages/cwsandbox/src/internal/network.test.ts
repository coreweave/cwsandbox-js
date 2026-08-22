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
