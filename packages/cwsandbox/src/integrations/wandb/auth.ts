// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CWSandboxConfigurationError } from "../../errors.js";
import type { DataPlaneMode } from "../../public/common.js";

declare const __VERSION__: string | undefined;

const WANDB_NETRC_MACHINES = ["api.wandb.ai", "wandb.ai"] as const;
const DEFAULT_SANDBOX_INTEGRATION = "js-sdk";
const CWSANDBOX_CLIENT_VERSION =
  typeof __VERSION__ === "string" && __VERSION__ !== "" ? __VERSION__ : "unknown";

type EnvironmentValue = string | undefined;
type WandbMetadata = Readonly<Record<string, string>>;

export interface WandbSandboxEnvironment extends Readonly<Record<string, EnvironmentValue>> {
  readonly WANDB_API_KEY?: string;
  readonly WANDB_ENTITY?: string;
  readonly WANDB_PROJECT?: string;
  readonly WANDB_SANDBOX_BASE_URL?: string;
}

export interface WandbSandboxClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly dataPlaneMode?: DataPlaneMode;
  readonly entity?: string;
  readonly env?: WandbSandboxEnvironment;
  readonly netrcPath?: string;
  readonly project?: string;
}

export interface WandbAuthOptions {
  readonly apiKey?: string;
  readonly entity?: string;
  readonly env?: WandbSandboxEnvironment;
  readonly netrcPath?: string;
  readonly project?: string;
}

interface ResolveWandbApiKeyOptions {
  readonly apiKey?: string;
  readonly env?: WandbSandboxEnvironment;
  readonly netrcPath?: string;
}

export function toWandbMetadata(options: WandbAuthOptions = {}): WandbMetadata {
  const env = options.env ?? process.env;
  const metadata: Record<string, string> = {
    "x-cwsandbox-client-version": CWSANDBOX_CLIENT_VERSION,
    "x-sandbox-integration": DEFAULT_SANDBOX_INTEGRATION,
    "x-wandb-api-key": resolveWandbApiKey({
      env,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.netrcPath === undefined ? {} : { netrcPath: options.netrcPath }),
    }),
    "x-wandb-sdk-version": CWSANDBOX_CLIENT_VERSION,
  };
  const entity = optionalTrimmed(options.entity) ?? optionalTrimmed(env["WANDB_ENTITY"]);
  const project = optionalTrimmed(options.project) ?? optionalTrimmed(env["WANDB_PROJECT"]);

  if (entity !== undefined) {
    metadata["x-entity-id"] = entity;
  }
  if (project !== undefined) {
    metadata["x-project-name"] = project;
  }

  return metadata;
}

export function resolveWandbApiKey(options: ResolveWandbApiKeyOptions = {}): string {
  const explicit = optionalTrimmed(options.apiKey);
  if (explicit !== undefined) {
    return explicit;
  }

  const env = options.env ?? process.env;
  const fromEnv = optionalTrimmed(env["WANDB_API_KEY"]);
  if (fromEnv !== undefined) {
    return fromEnv;
  }

  const fromNetrc = readWandbApiKeyFromNetrc(options.netrcPath ?? defaultNetrcPath());
  if (fromNetrc !== undefined) {
    return fromNetrc;
  }

  throw new CWSandboxConfigurationError(
    "W&B API key is required for W&B sandbox auth. Set apiKey, WANDB_API_KEY, or log in with a .netrc entry for api.wandb.ai.",
  );
}

export function readWandbApiKeyFromNetrc(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  return parseWandbApiKeyFromNetrc(readFileSync(path, "utf8"));
}

export function parseWandbApiKeyFromNetrc(contents: string): string | undefined {
  const tokens = tokenizeNetrc(contents);

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "machine") {
      continue;
    }

    const machine = tokens[index + 1];
    if (!isWandbNetrcMachine(machine)) {
      continue;
    }

    for (let fieldIndex = index + 2; fieldIndex < tokens.length; fieldIndex += 2) {
      const key = tokens[fieldIndex];
      if (key === "machine") {
        break;
      }
      if (key === "password") {
        return optionalTrimmed(tokens[fieldIndex + 1]);
      }
    }
  }

  return undefined;
}

function defaultNetrcPath(): string {
  return join(homedir(), ".netrc");
}

function isWandbNetrcMachine(value: string | undefined): boolean {
  return WANDB_NETRC_MACHINES.some((machine) => machine === value);
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function tokenizeNetrc(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, ""))
    .join("\n")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}
