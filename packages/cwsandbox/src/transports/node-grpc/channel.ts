// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { ChannelCredentials, type ClientOptions } from "@grpc/grpc-js";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";

import { CWSandboxConfigurationError } from "../../errors.js";
import { DEFAULT_GRPC_MAX_MESSAGE_LENGTH_BYTES } from "../../internal/file-limits.js";
import { SandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";

/** Match Python `_default_channel_options` (default grpc-js limit is only 4 MiB). */
export const GRPC_CLIENT_OPTIONS: ClientOptions = {
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
