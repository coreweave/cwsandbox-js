// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { SandboxClient } from "../client.js";
import { CWSandboxConfigurationError } from "../errors.js";
import { GrpcSandboxTransport } from "../transports/node-grpc/grpc-transport.js";

export { DEFAULT_KEEP_ALIVE_COMMAND } from "../defaults.js";
export { GrpcSandboxTransport } from "../transports/node-grpc/grpc-transport.js";
export type { GrpcSandboxTransportOptions } from "../transports/node-grpc/grpc-transport.js";
export { DEFAULT_CONTAINER_IMAGE } from "../transports/node-grpc/mappers.js";

export const DEFAULT_BASE_URL = "https://api.cwsandbox.com";
type EnvironmentValue = string | undefined;

export interface CWSandboxEnvironment extends Readonly<Record<string, EnvironmentValue>> {
  readonly CWSANDBOX_API_KEY?: string;
  readonly CWSANDBOX_BASE_URL?: string;
}

export interface NodeSandboxClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export function createSandboxClient(options: NodeSandboxClientOptions): SandboxClient {
  const apiKey = options.apiKey.trim();
  if (apiKey === "") {
    throw new CWSandboxConfigurationError("CWSandbox API key is required.");
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);

  return new SandboxClient({
    transport: new GrpcSandboxTransport({
      apiKey,
      baseUrl,
    }),
  });
}

export function createSandboxClientFromEnv(env: CWSandboxEnvironment = process.env): SandboxClient {
  const apiKey = env.CWSANDBOX_API_KEY ?? "";
  const baseUrl = env.CWSANDBOX_BASE_URL?.trim();

  return createSandboxClient({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const value = baseUrl?.trim().replace(/\/+$/, "");
  return value === undefined || value === "" ? DEFAULT_BASE_URL : value;
}
