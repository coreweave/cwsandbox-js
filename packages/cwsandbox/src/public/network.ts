// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export type EndpointAuth = "open";
export type EndpointKind = "https";
export type ServiceProtocol = "sctp" | "tcp" | "udp";
export type ServiceVisibility = "custom" | "private" | "public";

export interface Endpoint {
  readonly auth: EndpointAuth;
  readonly kind: EndpointKind;
}

export interface Service {
  readonly endpoint?: Endpoint;
  readonly name?: string;
  readonly port: number;
  readonly protocol?: ServiceProtocol;
  readonly visibility?: ServiceVisibility;
}

/**
 * One create-time HTTPS (TCP 443) hostname grant.
 *
 * Exact names (`pypi.org`) or a single leftmost wildcard (`*.pypi.org`).
 * `"*"` is a policy ceiling, not a sandbox grant.
 */
export interface EgressRule {
  readonly dnsName: string;
}

export interface NetworkOptions {
  /**
   * When true, deny outbound traffic. When omitted, the fleet policy default
   * applies — that is not the same as “the internet is allowed”.
   * Mutually exclusive with a non-empty `egress` list.
   */
  readonly denyEgress?: boolean;
  /**
   * When true, deny inbound traffic to CUSTOM-visibility ports. No-op when the
   * sandbox has no CUSTOM ports. Does not hide a public HTTPS endpoint.
   */
  readonly denyIngress?: boolean;
  /**
   * Hostnames the sandbox may reach over HTTPS (TCP 443). Frozen at create.
   * Empty or omitted leaves the fleet policy default. A wildcard is one
   * leftmost label only (`*.pypi.org` does not include apex `pypi.org`).
   */
  readonly egress?: readonly EgressRule[];
}

export interface ServiceUrl {
  readonly name: string;
  readonly port: number;
  readonly url: string;
}
