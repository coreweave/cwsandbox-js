// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export type EndpointAuth = "open" | "share_token";
export type EndpointKind = "https" | "tls_passthrough";
export type ServiceProtocol = "sctp" | "tcp" | "udp";
export type ServiceVisibility = "custom" | "private" | "public";

export interface HttpsEndpoint {
  readonly auth: EndpointAuth;
  readonly kind: "https";
  /**
   * Server-side HTTPS request clock on this product endpoint (504 while the
   * sandbox stays alive). Not `timeoutMs` on `client.run` / RPCs. Omit or `0`
   * is the platform default (15s on serverless). The SDK only requires an
   * integer; Aviato currently accepts `0` or `[15, 900]`.
   */
  readonly requestTimeoutSeconds?: number;
}

/**
 * TLS passthrough product endpoint. The platform forwards TLS by SNI to the
 * container. `auth` and `requestTimeoutSeconds` must be omitted. The assigned
 * target is `host:port` on `serviceAddresses`. Use the host as TLS SNI. The
 * workload owns certs.
 */
export interface TlsPassthroughEndpoint {
  readonly kind: "tls_passthrough";
}

export type Endpoint = HttpsEndpoint | TlsPassthroughEndpoint;

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

/** Relational peer scope for tenant network rules. */
export type TenantScope = "unspecified" | "same_user" | "same_org" | "sandbox_network";

/** An IP range with optional carved-out sub-ranges. */
export interface CidrBlock {
  readonly cidr: string;
  readonly exceptCidrs?: readonly string[];
}

/** A single port, or an inclusive range when `endPort` is set. */
export interface PortRange {
  readonly port: number;
  readonly endPort?: number;
  /** `"TCP"`, `"UDP"`, or `"SCTP"`. Omitted means TCP. */
  readonly protocol?: string;
}

/** Cluster workloads selected by pod and namespace labels. */
export interface SelectorBlock {
  readonly podLabels: Readonly<Record<string, string>>;
  /** Omitted means the sandbox's own namespace only. */
  readonly namespaceLabels?: Readonly<Record<string, string>>;
}

/**
 * One egress rule in effect, echoed from status: the declared rules, or the
 * policy default when none were declared. Exactly one of `dnsName`, `cidr`,
 * `tenant`, `any`, or `selector` is set. Omitted `ports` means all ports, or
 * HTTPS (TCP 443) for a `dnsName` rule.
 */
export interface EffectiveEgressRule {
  readonly dnsName?: string;
  readonly cidr?: CidrBlock;
  readonly tenant?: TenantScope;
  readonly any?: true;
  readonly selector?: SelectorBlock;
  readonly ports?: readonly PortRange[];
}

/**
 * One ingress rule in effect, echoed from status. Exactly one of `cidr`,
 * `tenant`, or `any` is set. Omitted `ports` means all CUSTOM-visibility ports.
 */
export interface EffectiveIngressRule {
  readonly cidr?: CidrBlock;
  readonly tenant?: TenantScope;
  readonly any?: true;
  readonly ports?: readonly PortRange[];
}

/**
 * One create-time inbound source for CUSTOM-visibility ports. Set exactly one
 * of `cidr`, `tenant`, or `any: true`. A rule outside the runner policy's
 * allowed ingress is rejected at create, never narrowed.
 */
export interface IngressRule {
  readonly cidr?: CidrBlock;
  /**
   * `"same_user"` or `"same_org"`. `"sandbox_network"` is not accepted by the
   * backend yet, and `"unspecified"` is rejected client-side.
   */
  readonly tenant?: TenantScope;
  /** Any source, including the public internet. */
  readonly any?: boolean;
  /** Ports this rule applies to. Empty or omitted means all CUSTOM ports. */
  readonly ports?: readonly PortRange[];
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
  /**
   * Inbound sources for CUSTOM-visibility ports, allow-only over default deny.
   * Empty or omitted leaves the policy default. Ignored when `denyIngress` is
   * true.
   */
  readonly ingress?: readonly IngressRule[];
}

export interface ServiceUrl {
  readonly name: string;
  readonly port: number;
  readonly url: string;
}

/**
 * Applied HTTPS product endpoint echoed on `serviceEndpoints`.
 *
 * Present when proto `requestTimeoutSeconds` is greater than 0. `url` may be
 * `""` when the API suppresses the hostname (for example a terminal Get).
 */
export interface HttpsEndpointStatus {
  readonly auth: EndpointAuth;
  readonly kind: "https";
  readonly name: string;
  readonly port: number;
  readonly requestTimeoutSeconds: number;
  readonly url: string;
}

/**
 * Applied TLS passthrough endpoint echoed on `serviceAddresses`.
 *
 * `address` is `host:port`. Use the host as TLS SNI. The workload owns certs.
 */
export interface TlsPassthroughEndpointStatus {
  readonly address: string;
  readonly kind: "tls_passthrough";
  readonly name: string;
  readonly port: number;
}
