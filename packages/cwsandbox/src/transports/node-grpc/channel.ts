// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { ChannelCredentials, type Client, type ClientOptions } from "@grpc/grpc-js";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";

import { CWSandboxConfigurationError } from "../../errors.js";
import { DEFAULT_GRPC_MAX_MESSAGE_LENGTH_BYTES } from "../../internal/file-limits.js";
import type { DataPlaneRpcClient } from "./data-plane-rpc.js";
import { SandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";
import { SandboxDataPlaneServiceClient } from "./generated/coreweave/sandbox/v1/sandbox_data_plane.client.js";

/** Match Python `_default_channel_options` (default grpc-js limit is only 4 MiB). */
const GRPC_CLIENT_OPTIONS: ClientOptions = {
  "grpc.max_receive_message_length": DEFAULT_GRPC_MAX_MESSAGE_LENGTH_BYTES,
  "grpc.max_send_message_length": DEFAULT_GRPC_MAX_MESSAGE_LENGTH_BYTES,
};

export type GrpcMetadata = Readonly<Record<string, string>>;

export interface GrpcClientOptions {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly metadata?: GrpcMetadata;
}

export interface GrpcClients {
  readonly client: SandboxServiceClient;
}

export interface MtlsDataPlaneSession {
  readonly client: DataPlaneRpcClient;
  close(): void;
  waitForReady(timeoutMs: number): Promise<void>;
}

export interface MtlsDataPlaneSessionOptions {
  readonly certificateChainPem: Uint8Array;
  readonly endpointUri: string;
  readonly privateKeyPem: Buffer;
  readonly serverCaBundlePem: Uint8Array;
}

export function createGrpcClients(options: GrpcClientOptions): GrpcClients {
  const target = parseGrpcTarget(options.baseUrl);
  const transport = new GrpcTransport({
    channelCredentials: target.secure
      ? ChannelCredentials.createSsl()
      : ChannelCredentials.createInsecure(),
    clientOptions: GRPC_CLIENT_OPTIONS,
    host: target.host,
    meta: toGrpcMetadata(options),
  });

  return {
    client: new SandboxServiceClient(transport),
  };
}

export function createMtlsDataPlaneSession(
  options: MtlsDataPlaneSessionOptions,
): MtlsDataPlaneSession {
  const target = parseGrpcTarget(options.endpointUri);
  if (!target.secure) {
    throw new CWSandboxConfigurationError("The direct data-plane endpoint must use HTTPS.");
  }

  const transport = new GrpcTransport({
    channelCredentials: ChannelCredentials.createSsl(
      options.serverCaBundlePem.byteLength === 0 ? null : Buffer.from(options.serverCaBundlePem),
      options.privateKeyPem,
      Buffer.from(options.certificateChainPem),
    ),
    clientOptions: GRPC_CLIENT_OPTIONS,
    host: target.host,
    meta: {},
  });

  return {
    client: new SandboxDataPlaneServiceClient(transport),
    close() {
      transport.close();
    },
    waitForReady(timeoutMs) {
      return waitForGrpcTransportReady(transport, timeoutMs);
    },
  };
}

function waitForGrpcTransportReady(transport: GrpcTransport, timeoutMs: number): Promise<void> {
  const client = (transport as unknown as { readonly client: Client }).client;
  return new Promise((resolve, reject) => {
    client.waitForReady(Date.now() + timeoutMs, (error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function toGrpcMetadata(options: GrpcClientOptions): GrpcMetadata {
  if (options.metadata !== undefined) {
    return { ...options.metadata };
  }

  if (options.apiKey !== undefined) {
    return {
      authorization: `Bearer ${options.apiKey}`,
    };
  }

  throw new CWSandboxConfigurationError("CWSandbox gRPC metadata or API key is required.");
}

interface GrpcTarget {
  readonly host: string;
  readonly secure: boolean;
}

export function parseGrpcTarget(baseUrl: string): GrpcTarget {
  const url = parseBaseUrl(baseUrl);

  if (url.protocol === "https:") {
    return { host: url.host, secure: true };
  }

  if (url.protocol === "http:") {
    return { host: url.host, secure: false };
  }

  throw new CWSandboxConfigurationError(`Unsupported CWSandbox base URL protocol: ${url.protocol}`);
}

function parseBaseUrl(baseUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch (error) {
    throw new CWSandboxConfigurationError(`Invalid CWSandbox base URL: ${baseUrl}`, {
      cause: error,
    });
  }
}
