// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { RequestOptions } from "./common.js";
import type { NetworkOptions } from "./network.js";

/** Top-level `NetworkOptions` fields an update can write. */
export type NetworkConfigUpdateField =
  | "denyEgress"
  | "denyIngress"
  | "dnsEgress"
  | "egress"
  | "ingress";

/**
 * Rule lists in a stored NetworkConfig that this SDK's `NetworkOptions`
 * cannot show in full, such as rules from a newer API version, hostname
 * excepts, or a hostname rule on ports other than TCP 443. The list is left
 * out of `network` when it is reported here.
 */
export type NetworkConfigUnsupportedField = "egress" | "ingress";

export interface NetworkConfigResult {
  readonly networkConfigId: string;
  /**
   * Desired network document. Holds only what the SDK models; see
   * `unsupportedFields` for anything the stored document has beyond that.
   */
  readonly network: NetworkOptions;
  /** Pass to `updateNetworkConfig` to reject the write if the config changed. */
  readonly etag?: string;
  /**
   * Last sandbox this config was bound to. May still name a sandbox that
   * has ended until the backend clears it.
   */
  readonly sandboxId?: string;
  /**
   * True when the backend created this config for a sandbox (create without
   * `networkConfigId`). The backend deletes it when that sandbox ends.
   */
  readonly platformManaged: boolean;
  /** Empty when `network` is the whole stored document. */
  readonly unsupportedFields: readonly NetworkConfigUnsupportedField[];
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface CreateNetworkConfigOptions extends RequestOptions {
  /** Initial rules. Omitted means the policy default. */
  readonly network?: NetworkOptions;
  /** Idempotency key; retrying with the same key returns the same config. */
  readonly requestId?: string;
}

export interface ListNetworkConfigsOptions extends RequestOptions {
  /** `true` lists only backend-created configs; `false` only your own. */
  readonly platformManaged?: boolean;
}

export interface UpdateNetworkConfigOptions extends RequestOptions {
  /**
   * Fields to write. Defaults to every field set on `network`. A named field
   * left unset on `network` is cleared (`egress` and `dnsEgress` to the
   * policy default, `deny*` to false). An empty array writes nothing and returns the
   * current config.
   */
  readonly updateMask?: readonly NetworkConfigUpdateField[];
  /**
   * Reject the write with `CWSandboxEtagMismatchError` if the config changed
   * since this etag was read. When the update writes `egress` and this is
   * omitted, the SDK reads the config first and uses its etag.
   */
  readonly etag?: string;
}

export interface DeleteNetworkConfigOptions extends RequestOptions {
  /** Return success when the config does not exist. */
  readonly missingOk?: boolean;
}
