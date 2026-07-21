// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../errors.js";
import type { EnvironmentVariables } from "../public/sandbox.js";
import type { SecretInput, Secrets } from "../public/secrets.js";

/** Gateway pre-resolve limit across all secret stores. */
export const MAX_SECRETS = 50;

export interface NormalizedSecret {
  readonly envVar: string;
  readonly field: string;
  readonly name: string;
  readonly store: string;
}

export interface SecretStoreGroup {
  readonly secrets: readonly {
    readonly envVar: string;
    readonly field: string;
    readonly name: string;
  }[];
  readonly store: string;
}

export function normalizeSecrets(secrets: Secrets | undefined): readonly NormalizedSecret[] {
  if (secrets === undefined) {
    return [];
  }

  return secrets.map((secret) => ({
    envVar: secret.envVar ?? secret.name,
    field: secret.field ?? "",
    name: secret.name,
    store: secret.store,
  }));
}

export function validateSecrets(
  secrets: Secrets | undefined,
  environmentVariables: EnvironmentVariables | undefined = undefined,
): void {
  if (secrets === undefined) {
    return;
  }

  if (!Array.isArray(secrets)) {
    throw new CWSandboxValidationError("secrets must be an array");
  }

  if (secrets.length > MAX_SECRETS) {
    throw new CWSandboxValidationError(`secrets must contain ${MAX_SECRETS} entries or fewer`);
  }

  for (const secret of secrets) {
    validateSecretInputShape(secret);
  }

  const normalized = normalizeSecrets(secrets);
  const seenEnvVars = new Set<string>();
  const environmentKeys = new Set(Object.keys(environmentVariables ?? {}));

  for (const secret of normalized) {
    validateNonEmptyString(secret.store, "secrets.store");
    validateNonEmptyString(secret.name, "secrets.name");
    validateNonEmptyString(secret.envVar, "secrets.envVar");

    if (secret.field !== "" && secret.field.trim() === "") {
      throw new CWSandboxValidationError("secrets.field must not be blank");
    }

    if (seenEnvVars.has(secret.envVar)) {
      throw new CWSandboxValidationError(`secrets contains duplicate envVar: ${secret.envVar}`);
    }
    if (environmentKeys.has(secret.envVar)) {
      throw new CWSandboxValidationError(
        `secrets envVar "${secret.envVar}" conflicts with environmentVariables`,
      );
    }
    seenEnvVars.add(secret.envVar);
  }
}

export function groupSecretsByStore(
  secrets: readonly NormalizedSecret[],
): readonly SecretStoreGroup[] {
  const grouped = new Map<string, SecretStoreGroup["secrets"][number][]>();

  for (const secret of secrets) {
    const mappings = grouped.get(secret.store) ?? [];
    mappings.push({
      envVar: secret.envVar,
      field: secret.field,
      name: secret.name,
    });
    grouped.set(secret.store, mappings);
  }

  return [...grouped.entries()].map(([store, storeSecrets]) => ({
    secrets: storeSecrets,
    store,
  }));
}

function validateSecretInputShape(secret: SecretInput): void {
  if (secret === null || typeof secret !== "object" || Array.isArray(secret)) {
    throw new CWSandboxValidationError("secrets entries must be objects");
  }
}

function validateNonEmptyString(value: string, fieldName: string): void {
  if (typeof value !== "string" || value === "") {
    throw new CWSandboxValidationError(`${fieldName} must not be empty`);
  }
}
