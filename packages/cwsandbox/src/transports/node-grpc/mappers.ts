// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { commandForWorkingDirectory } from "../../internal/commands.js";
import { normalizeFileContent, normalizeMountedFiles } from "../../internal/mounted-files.js";
import { normalizePorts } from "../../internal/network.js";
import { isAdvancedResources } from "../../internal/resources.js";
import { normalizeSecrets } from "../../internal/secrets.js";
import type { Command, ProcessResult } from "../../public/commands.js";
import type { NetworkOptions } from "../../public/network.js";
import type { ResourceOptions, ResourceSpec } from "../../public/resources.js";
import type {
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  SandboxExposedPort,
  SandboxInfo,
  SandboxStatus,
  StartSandboxResult,
} from "../../public/sandbox.js";
import type { ExecRequest, StartSandboxRequest } from "../../transport/types.js";
import {
  OutputPolicy as ProtoOutputPolicy,
  SandboxStatus as ProtoSandboxStatus,
} from "./generated/coreweave/sandbox/v1beta2/gateway.js";
import type {
  ExecSandboxRequest as ProtoExecSandboxRequest,
  ExecResponse as ProtoExecResponse,
  GetSandboxResponse as ProtoGetSandboxResponse,
  MountedFile as ProtoMountedFile,
  NetworkOptions as ProtoNetworkOptions,
  Port as ProtoPort,
  ListSandboxesRequest as ProtoListSandboxesRequest,
  ListSandboxesResponse as ProtoListSandboxesResponse,
  ResourceRequest as ProtoResourceRequest,
  SandboxInfo as ProtoSandboxInfo,
  StartSandboxRequest as ProtoStartSandboxRequest,
  StartSandboxResponse as ProtoStartSandboxResponse,
} from "./generated/coreweave/sandbox/v1beta2/gateway.js";
import type { SecretStoreReference as ProtoSecretStoreReference } from "./generated/coreweave/sandbox/v1beta2/secrets.js";
import type { Timestamp as ProtoTimestamp } from "./generated/google/protobuf/timestamp.js";

const textDecoder = new TextDecoder();

export const DEFAULT_CONTAINER_IMAGE = "python:3.11";

export function commandName(command: Command): string {
  return command[0];
}

export function commandArgs(command: Command): string[] {
  return command.slice(1);
}

export function timeoutMsToSeconds(timeoutMs: number | undefined): number {
  return timeoutMs === undefined ? 0 : Math.ceil(timeoutMs / 1000);
}

export function toProtoStartRequest(request: StartSandboxRequest): ProtoStartSandboxRequest {
  return {
    args: commandArgs(request.command),
    command: commandName(request.command),
    containerImage: request.containerImage ?? DEFAULT_CONTAINER_IMAGE,
    ...toProtoStartMetadata(request),
    ...toProtoResources(request.resources),
    ...toProtoStartFiles(request),
    ...toProtoStartNetwork(request),
    ...toProtoStartPlacement(request),
    runnerClusterSecrets: [],
    secretStores: toProtoSecretStores(request.secrets),
  };
}

function toProtoSecretStores(secrets: StartSandboxRequest["secrets"]): ProtoSecretStoreReference[] {
  const grouped = new Map<string, ProtoSecretStoreReference["secrets"]>();

  for (const secret of normalizeSecrets(secrets)) {
    const mappings = grouped.get(secret.store) ?? [];
    mappings.push({
      envVar: secret.envVar,
      field: secret.field,
      path: secret.name,
    });
    grouped.set(secret.store, mappings);
  }

  return [...grouped.entries()].map(([storeName, storeSecrets]) => ({
    secrets: storeSecrets,
    storeName,
  }));
}

function toProtoStartMetadata(request: StartSandboxRequest): {
  readonly environmentVariables: Record<string, string>;
  readonly maxLifetimeSeconds: number;
  readonly maxTimeoutSeconds: number;
  readonly podAnnotations: Record<string, string>;
  readonly tags: string[];
} {
  return {
    environmentVariables: { ...request.environmentVariables },
    maxLifetimeSeconds: request.maxLifetimeSeconds ?? 0,
    maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
    podAnnotations: { ...request.annotations },
    tags: [...(request.tags ?? [])],
  };
}

function toProtoStartFiles(request: StartSandboxRequest): {
  readonly mountedFiles: ProtoMountedFile[];
} {
  return {
    mountedFiles: toProtoMountedFiles(request.mountedFiles),
  };
}

function toProtoStartNetwork(request: StartSandboxRequest): {
  readonly network?: ProtoNetworkOptions;
  readonly ports: ProtoPort[];
} {
  return {
    ...(request.network === undefined ? {} : { network: toProtoNetworkOptions(request.network) }),
    ports: toProtoPorts(request.ports),
  };
}

function toProtoStartPlacement(request: StartSandboxRequest): {
  readonly profileIds: string[];
  readonly profileNames: string[];
  readonly runnerIds: string[];
} {
  return {
    profileIds: [...(request.profileIds ?? [])],
    profileNames: [...(request.profileNames ?? [])],
    runnerIds: [...(request.runnerIds ?? [])],
  };
}

function toProtoPorts(ports: StartSandboxRequest["ports"]): ProtoPort[] {
  return normalizePorts(ports).map((port) => ({
    containerPort: port.port,
    name: port.name ?? "",
    protocol: port.protocol ?? "",
  }));
}

function toProtoNetworkOptions(network: NetworkOptions): ProtoNetworkOptions {
  return {
    egressMode: network.egressMode ?? "",
    exposedPorts: [...(network.exposedPorts ?? [])],
    ingressMode: network.ingressMode ?? "",
  };
}

function toProtoResources(resources: ResourceOptions | undefined): {
  readonly resourceLimits?: ReturnType<typeof toProtoResourceSpec>;
  readonly resourceRequests?: ReturnType<typeof toProtoResourceSpec>;
  readonly resources?: ReturnType<typeof toProtoResourceSpec>;
} {
  if (resources === undefined) {
    return {};
  }

  if (isAdvancedResources(resources)) {
    return {
      resourceLimits: toProtoResourceSpec(resources.limits),
      resourceRequests: toProtoResourceSpec(resources.requests),
    };
  }

  return {
    resources: toProtoResourceSpec(resources),
  };
}

function toProtoResourceSpec(spec: ResourceSpec): {
  readonly cpu: string;
  readonly memory: string;
} {
  return {
    cpu: spec.cpu ?? "",
    memory: spec.memory ?? "",
  };
}

function toProtoMountedFiles(
  mountedFiles: StartSandboxRequest["mountedFiles"],
): ProtoMountedFile[] {
  return normalizeMountedFiles(mountedFiles).map((file) => ({
    fileContent: normalizeFileContent(file.content),
    mountPath: file.path,
  }));
}

export function toProtoExecRequest(request: ExecRequest): ProtoExecSandboxRequest {
  return {
    args: [],
    bufferedMaxKib: request.bufferedMaxKiB ?? 0,
    command: toExecCommand(request),
    maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
    outputHandling:
      request.bufferedMaxKiB === undefined
        ? ProtoOutputPolicy.UNSPECIFIED
        : ProtoOutputPolicy.BUFFERED,
    sandboxId: request.sandboxId,
  };
}

export function toProtoListSandboxesRequest(
  request: ListSandboxesOptions,
): ProtoListSandboxesRequest {
  return {
    includeStopped: request.includeStopped ?? false,
    maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
    pageSize: request.pageSize ?? 0,
    pageToken: request.pageToken ?? "",
    profileIds: [...(request.profileIds ?? [])],
    profileNames: [...(request.profileNames ?? [])],
    runnerIds: [...(request.runnerIds ?? [])],
    status: toProtoSandboxStatus(request.status),
    tags: [...(request.tags ?? [])],
  };
}

export function toSdkProcessResult(command: Command, response: ProtoExecResponse): ProcessResult {
  return {
    command,
    exitCode: response.exitCode,
    failed: response.exitCode !== 0,
    ok: response.exitCode === 0,
    stderr: textDecoder.decode(response.stderr),
    stderrBytes: response.stderr,
    stderrBytesProduced: toByteCount(response.stderrBytesProduced, response.stderr),
    stderrTruncated: response.stderrTruncated,
    stdout: textDecoder.decode(response.stdout),
    stdoutBytes: response.stdout,
    stdoutBytesProduced: toByteCount(response.stdoutBytesProduced, response.stdout),
    stdoutTruncated: response.stdoutTruncated,
  };
}

export function toSdkListSandboxesResult(
  response: ProtoListSandboxesResponse,
): ListSandboxesResult {
  return {
    ...(response.nextPageToken === "" ? {} : { nextPageToken: response.nextPageToken }),
    sandboxes: response.sandboxes.map(toSdkSandboxInfo),
  };
}

export function toSdkStartSandboxResult(response: ProtoStartSandboxResponse): StartSandboxResult {
  return {
    ...toSdkSandboxMetadata({
      appliedEgressMode: response.appliedEgressMode,
      appliedIngressMode: response.appliedIngressMode,
      exposedPorts: response.exposedPorts,
      profileId: response.profileId,
      resourceLimits: response.requestedResourceLimits,
      resourceRequests: response.requestedResourceRequests,
      runnerId: response.runnerId,
      sandboxId: response.sandboxId,
      serviceAddress: response.serviceAddress,
      startedAtTime: response.startedAtTime,
      status: response.sandboxStatus,
    }),
  };
}

export function toSdkGetSandboxResult(response: ProtoGetSandboxResponse): GetSandboxResult {
  return {
    ...toSdkSandboxMetadata({
      appliedEgressMode: response.appliedEgressMode,
      appliedIngressMode: response.appliedIngressMode,
      exposedPorts: response.exposedPorts,
      profileId: response.profileId,
      runnerGroupId: response.runnerGroupId,
      runnerId: response.runnerId,
      sandboxId: response.sandboxId,
      serviceAddress: response.serviceAddress,
      startedAtTime: response.startedAtTime,
      status: response.sandboxStatus,
      statusReason: response.statusReason,
    }),
    status: toSdkSandboxStatus(response.sandboxStatus),
  };
}

export function toSdkSandboxInfo(info: ProtoSandboxInfo): SandboxInfo {
  return {
    ...toSdkSandboxMetadata({
      appliedEgressMode: info.appliedEgressMode,
      appliedIngressMode: info.appliedIngressMode,
      exposedPorts: info.exposedPorts,
      profileId: info.profileId,
      runnerGroupId: info.runnerGroupId,
      runnerId: info.runnerId,
      sandboxId: info.sandboxId,
      serviceAddress: info.serviceAddress,
      startedAtTime: info.startedAtTime,
      status: info.sandboxStatus,
    }),
    status: toSdkSandboxStatus(info.sandboxStatus),
  };
}

function toSdkSandboxMetadata(input: {
  readonly appliedEgressMode?: string;
  readonly appliedIngressMode?: string;
  readonly exposedPorts?: readonly ProtoPort[] | undefined;
  readonly profileId?: string;
  readonly resourceLimits?: ProtoResourceRequest | undefined;
  readonly resourceRequests?: ProtoResourceRequest | undefined;
  readonly runnerGroupId?: string;
  readonly runnerId?: string;
  readonly sandboxId: string;
  readonly serviceAddress?: string;
  readonly startedAtTime?: ProtoTimestamp | undefined;
  readonly status?: ProtoSandboxStatus;
  readonly statusReason?: string;
}): StartSandboxResult {
  const exposedPorts = toSdkExposedPorts(input.exposedPorts);
  const resourceLimits = toSdkResourceSpec(input.resourceLimits);
  const resourceRequests = toSdkResourceSpec(input.resourceRequests);
  const startedAt = toDate(input.startedAtTime);

  return {
    ...(input.appliedEgressMode === undefined || input.appliedEgressMode === ""
      ? {}
      : { appliedEgressMode: input.appliedEgressMode }),
    ...(input.appliedIngressMode === undefined || input.appliedIngressMode === ""
      ? {}
      : { appliedIngressMode: input.appliedIngressMode }),
    ...(exposedPorts === undefined ? {} : { exposedPorts }),
    ...(input.profileId === undefined || input.profileId === ""
      ? {}
      : { profileId: input.profileId }),
    ...(resourceLimits === undefined ? {} : { resourceLimits }),
    ...(resourceRequests === undefined ? {} : { resourceRequests }),
    ...(input.runnerGroupId === undefined || input.runnerGroupId === ""
      ? {}
      : { runnerGroupId: input.runnerGroupId }),
    ...(input.runnerId === undefined || input.runnerId === "" ? {} : { runnerId: input.runnerId }),
    sandboxId: input.sandboxId,
    ...(input.serviceAddress === undefined || input.serviceAddress === ""
      ? {}
      : { serviceAddress: input.serviceAddress }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(input.status === undefined ? {} : { status: toSdkSandboxStatus(input.status) }),
    ...(input.statusReason === undefined || input.statusReason === ""
      ? {}
      : { statusReason: input.statusReason }),
  };
}

function toSdkExposedPorts(
  ports: readonly ProtoPort[] | undefined,
): readonly SandboxExposedPort[] | undefined {
  if (ports === undefined || ports.length === 0) {
    return undefined;
  }

  return ports.map((port) => ({
    ...(port.name === "" ? {} : { name: port.name }),
    port: port.containerPort,
    ...(port.protocol === "" ? {} : { protocol: port.protocol }),
  }));
}

function toSdkResourceSpec(resource: ProtoResourceRequest | undefined): ResourceSpec | undefined {
  if (resource === undefined) {
    return undefined;
  }

  const spec: ResourceSpec = {
    ...(resource.cpu === "" ? {} : { cpu: resource.cpu }),
    ...(resource.memory === "" ? {} : { memory: resource.memory }),
  };

  return spec.cpu === undefined && spec.memory === undefined ? undefined : spec;
}

function toDate(timestamp: ProtoTimestamp | undefined): Date | undefined {
  if (timestamp === undefined) {
    return undefined;
  }

  const seconds = Number(timestamp.seconds);
  if (!Number.isFinite(seconds)) {
    return undefined;
  }

  return new Date(seconds * 1000 + Math.floor(timestamp.nanos / 1_000_000));
}

export function toSdkSandboxStatus(status: ProtoSandboxStatus): SandboxStatus {
  switch (status) {
    case ProtoSandboxStatus.PENDING:
      return "pending";
    case ProtoSandboxStatus.CREATING:
      return "creating";
    case ProtoSandboxStatus.RUNNING:
      return "running";
    case ProtoSandboxStatus.PAUSED:
      return "paused";
    case ProtoSandboxStatus.TERMINATING:
      return "terminating";
    case ProtoSandboxStatus.COMPLETED:
      return "completed";
    case ProtoSandboxStatus.FAILED:
      return "failed";
    case ProtoSandboxStatus.TERMINATED:
      return "terminated";
    case ProtoSandboxStatus.UNSPECIFIED:
      return "unspecified";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Unhandled sandbox status: ${_exhaustiveCheck}`);
    }
  }
}

function toProtoSandboxStatus(status: SandboxStatus | undefined): ProtoSandboxStatus {
  switch (status) {
    case undefined:
    case "unspecified":
      return ProtoSandboxStatus.UNSPECIFIED;
    case "pending":
      return ProtoSandboxStatus.PENDING;
    case "creating":
      return ProtoSandboxStatus.CREATING;
    case "running":
      return ProtoSandboxStatus.RUNNING;
    case "paused":
      return ProtoSandboxStatus.PAUSED;
    case "terminating":
      return ProtoSandboxStatus.TERMINATING;
    case "completed":
      return ProtoSandboxStatus.COMPLETED;
    case "failed":
      return ProtoSandboxStatus.FAILED;
    case "terminated":
      return ProtoSandboxStatus.TERMINATED;
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Unhandled sandbox status: ${_exhaustiveCheck}`);
    }
  }
}

function toExecCommand(request: ExecRequest): string[] {
  return commandForWorkingDirectory(request.command, request.cwd);
}

function toByteCount(value: string, fallback: Uint8Array): number {
  if (value === "") {
    return fallback.byteLength;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback.byteLength;
  }

  return parsed === 0 && fallback.byteLength > 0 ? fallback.byteLength : parsed;
}
