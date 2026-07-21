// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { ChannelCredentials } from "@grpc/grpc-js";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";

import { CWSandboxConfigurationError } from "../../errors.js";
import { GatewayServiceClient } from "./generated/coreweave/sandbox/v1beta2/gateway.client.js";
import { GatewayStreamingServiceClient } from "./generated/coreweave/sandbox/v1beta2/streaming.client.js";

export type GrpcMetadata = Readonly<Record<string, string>>;

export interface GrpcClientOptions {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly metadata?: GrpcMetadata;
}

export interface GrpcClients {
  readonly client: GatewayServiceClient;
  readonly streamingClient: GatewayStreamingServiceClient;
}

export function createGrpcClients(options: GrpcClientOptions): GrpcClients {
  const target = parseGrpcTarget(options.baseUrl);
  const transport = new GrpcTransport({
    channelCredentials: target.secure
      ? ChannelCredentials.createSsl()
      : ChannelCredentials.createInsecure(),
    host: target.host,
    meta: toGrpcMetadata(options),
  });

  return {
    client: new GatewayServiceClient(transport),
    streamingClient: new GatewayStreamingServiceClient(transport),
  };
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

function parseGrpcTarget(baseUrl: string): GrpcTarget {
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
