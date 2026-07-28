// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { SandboxClient } from "../client.js";
import type { SandboxClient as SandboxClientInterface } from "../public/client.js";
import {
  toWandbMetadata,
  type WandbSandboxClientOptions,
  type WandbSandboxEnvironment,
} from "../integrations/wandb/auth.js";
import { createGrpcFileAdapter } from "../transports/node-grpc/file-adapter.js";
import { GrpcSandboxTransport } from "../transports/node-grpc/grpc-transport.js";

export {
  toWandbMetadata,
  type WandbSandboxClientOptions,
  type WandbSandboxEnvironment,
} from "../integrations/wandb/auth.js";
export type { SandboxClient } from "../public/client.js";
export type {
  EnvironmentVariables,
  SandboxRunOptions,
  SandboxStatus,
  SandboxTag,
} from "../public/sandbox.js";

export const DEFAULT_WANDB_SANDBOX_BASE_URL = "https://api.cwsandbox.com";

export function createSandboxClient(options: WandbSandboxClientOptions = {}): SandboxClientInterface {
  const env = options.env ?? process.env;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? env["WANDB_SANDBOX_BASE_URL"]);
  const transport = new GrpcSandboxTransport({
    baseUrl,
    metadata: toWandbMetadata({
      env,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.entity === undefined ? {} : { entity: options.entity }),
      ...(options.netrcPath === undefined ? {} : { netrcPath: options.netrcPath }),
      ...(options.project === undefined ? {} : { project: options.project }),
    }),
  });
  const fileAdapter = createGrpcFileAdapter(transport.clients);

  return new SandboxClient({ fileAdapter, transport });
}

export function createSandboxClientFromEnv(
  env: WandbSandboxEnvironment = process.env,
): SandboxClientInterface {
  return createSandboxClient({ env });
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const value = baseUrl?.trim().replace(/\/+$/, "");
  return value === undefined || value === "" ? DEFAULT_WANDB_SANDBOX_BASE_URL : value;
}
