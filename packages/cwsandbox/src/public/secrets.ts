// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * A secret reference resolved server-side and injected as an environment variable.
 *
 * Shape matches the Python SDK `Secret` (`store`, `name`, `field`, `env_var`), with
 * camelCase `envVar` for TypeScript. Values are never sent by the client.
 *
 * `store` must match a Gateway-registered secret store name for the organization
 * (for W&B, typically `wandb-team-secrets`). When `envVar` is omitted it defaults
 * to `name`. On the wire, `name` is sent as proto `SecretMapping.path`.
 */
export interface SecretInput {
  readonly envVar?: string;
  readonly field?: string;
  readonly name: string;
  readonly store: string;
}

export type Secrets = readonly SecretInput[];
