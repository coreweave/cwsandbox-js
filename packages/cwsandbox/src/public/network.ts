// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export type PortInput = number | PortOptions;
export type PortProtocol = "SCTP" | "TCP" | "UDP" | (string & {});

export interface PortOptions {
  readonly name?: string;
  readonly port: number;
  readonly protocol?: PortProtocol;
}

export interface NetworkOptions {
  readonly egressMode?: string;
  readonly exposedPorts?: readonly number[];
  readonly ingressMode?: string;
}
