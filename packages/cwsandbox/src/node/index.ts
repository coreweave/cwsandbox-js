// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { SandboxClient } from "../client.js";
import { CWSandboxConfigurationError } from "../errors.js";
import { DEFAULT_DATA_PLANE_MODE, validateDataPlaneMode } from "../internal/data-plane.js";
import type { SandboxClient as SandboxClientInterface } from "../public/client.js";
import type { DataPlaneMode } from "../public/common.js";
import { createGrpcFileAdapter } from "../transports/node-grpc/file-adapter.js";
import { GrpcSandboxTransport } from "../transports/node-grpc/grpc-transport.js";

export { DEFAULT_KEEP_ALIVE_COMMAND } from "../defaults.js";
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
  readonly dataPlaneMode?: DataPlaneMode;
}

export function createSandboxClient(options: NodeSandboxClientOptions): SandboxClientInterface {
  const apiKey = options.apiKey.trim();
  if (apiKey === "") {
    throw new CWSandboxConfigurationError("CWSandbox API key is required.");
  }

  validateDataPlaneMode(options.dataPlaneMode);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const transport = new GrpcSandboxTransport({ apiKey, baseUrl });
  const fileAdapter = createGrpcFileAdapter(transport.prepareDataPlaneCall);

  return new SandboxClient({
    dataPlaneMode: options.dataPlaneMode ?? DEFAULT_DATA_PLANE_MODE,
    fileAdapter,
    transport,
  });
}

export function createSandboxClientFromEnv(
  env: CWSandboxEnvironment = process.env,
): SandboxClientInterface {
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
