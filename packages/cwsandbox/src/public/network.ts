// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export type EndpointAuth = "open";
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

/**
 * Applied HTTPS product endpoint echoed on `serviceEndpoints`.
 *
 * Present when proto `requestTimeoutSeconds` is greater than 0. `url` may be
 * `""` when the API suppresses the hostname (for example a terminal Get).
 */
export interface HttpsEndpointStatus {
  readonly auth: "open";
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
