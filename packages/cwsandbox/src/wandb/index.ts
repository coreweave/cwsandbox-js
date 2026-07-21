// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { SandboxClient } from "../client.js";
import {
  toWandbMetadata,
  type WandbSandboxClientOptions,
  type WandbSandboxEnvironment,
} from "../integrations/wandb/auth.js";
import { GrpcSandboxTransport } from "../transports/node-grpc/grpc-transport.js";

export { SandboxClient } from "../client.js";
export {
  toWandbMetadata,
  type WandbSandboxClientOptions,
  type WandbSandboxEnvironment,
} from "../integrations/wandb/auth.js";
export type { SandboxTransport } from "../transport.js";
export type {
  EnvironmentVariables,
  SandboxRunOptions,
  SandboxStatus,
  SandboxTag,
} from "../public/sandbox.js";

export const DEFAULT_WANDB_SANDBOX_BASE_URL = "https://api.cwsandbox.com";

export function createSandboxClient(options: WandbSandboxClientOptions = {}): SandboxClient {
  const env = options.env ?? process.env;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? env["WANDB_SANDBOX_BASE_URL"]);

  return new SandboxClient({
    transport: new GrpcSandboxTransport({
      baseUrl,
      metadata: toWandbMetadata({
        env,
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.entity === undefined ? {} : { entity: options.entity }),
        ...(options.netrcPath === undefined ? {} : { netrcPath: options.netrcPath }),
        ...(options.project === undefined ? {} : { project: options.project }),
      }),
    }),
  });
}

export function createSandboxClientFromEnv(
  env: WandbSandboxEnvironment = process.env,
): SandboxClient {
  return createSandboxClient({ env });
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const value = baseUrl?.trim().replace(/\/+$/, "");
  return value === undefined || value === "" ? DEFAULT_WANDB_SANDBOX_BASE_URL : value;
}
