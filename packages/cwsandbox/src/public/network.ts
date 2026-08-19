// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export type EndpointAuth = "open";
export type EndpointKind = "https";
export type ServiceProtocol = "sctp" | "tcp" | "udp";
export type ServiceVisibility = "custom" | "private" | "public";

export interface Endpoint {
  readonly auth: EndpointAuth | string;
  readonly kind: EndpointKind | string;
}

export interface Service {
  readonly endpoint?: Endpoint;
  readonly name?: string;
  readonly port: number;
  readonly protocol?: ServiceProtocol | string;
  readonly visibility?: ServiceVisibility | string;
}

export interface NetworkOptions {
  readonly denyEgress?: boolean;
  readonly denyIngress?: boolean;
}

export interface ServiceUrl {
  readonly name: string;
  readonly port: number;
  readonly url: string;
}
