// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { randomUUID } from "node:crypto";

import { DEFAULT_SCRATCH_VOLUME_NAME } from "../../defaults.js";
import { commandForWorkingDirectory } from "../../internal/commands.js";
import { normalizeFileContent, normalizeMountedFiles } from "../../internal/mounted-files.js";
import { isAdvancedResources } from "../../internal/resources.js";
import { groupSecretsByStore, normalizeSecrets } from "../../internal/secrets.js";
import type { Command, ProcessResult } from "../../public/commands.js";
import type { NetworkOptions, Service, ServiceUrl } from "../../public/network.js";
import type { ResourceOptions, ResourceSpec } from "../../public/resources.js";
import type {
  FileSystemSnapshotResult,
  FileSystemSnapshotState,
  FileSystemSnapshotTrigger,
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  SandboxExposedPort,
  SandboxInfo,
  SandboxObjectStorageAccess,
  SandboxStatus,
  ScratchVolumeOptions,
  StartSandboxResult,
} from "../../public/sandbox.js";
import type { ExecRequest, StartSandboxRequest } from "../../transport/types.js";
import {
  Container,
  CreateSandboxRequest,
  DeleteSandboxRequest,
  EndpointAuth,
  EndpointKind,
  ExecRequest as ProtoExecRequest,
  ListSandboxesRequest,
  NetworkOptions as ProtoNetworkOptions,
  ObjectStorageAccess,
  ObjectStoragePermission,
  ResourceRequirements,
  Resources,
  Sandbox as ProtoSandbox,
  SandboxMode,
  SandboxSpec,
  SandboxVolume,
  ScratchVolume,
  Service as ProtoService,
  ServiceProtocol,
  SnapshotState,
  SnapshotTrigger,
  State,
  StreamLogsRequest as ProtoStreamLogsRequest,
  Visibility,
  VolumeMount,
  type ExecResponse as ProtoExecResponse,
  type FileSystemSnapshot as ProtoFileSystemSnapshot,
  type Sandbox as ProtoSandboxMessage,
  type ServiceStatus as ProtoServiceStatus,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import type { Timestamp as ProtoTimestamp } from "./generated/google/protobuf/timestamp.js";

const textDecoder = new TextDecoder();

export const DEFAULT_CONTAINER_IMAGE = "python:3.11";
const PRIMARY_CONTAINER = "main";

export function commandName(command: Command): string {
  return command[0];
}

export function commandArgs(command: Command): string[] {
  return command.slice(1);
}

export function timeoutMsToSeconds(timeoutMs: number | undefined): number {
  return timeoutMs === undefined ? 0 : Math.ceil(timeoutMs / 1000);
}

export function toProtoCreateRequest(request: StartSandboxRequest): CreateSandboxRequest {
  const runnerIds = [...(request.runnerIds ?? [])];
  const network = toProtoNetwork(request.network);
  const volumes = toProtoVolumes(request);
  const objectStorageAccess = toProtoObjectStorageAccess(request.objectStorageAccess);
  return CreateSandboxRequest.create({
    requestId: randomUUID(),
    sandbox: ProtoSandbox.create({
      spec: SandboxSpec.create({
        annotations: { ...request.annotations },
        containers: [toProtoContainer(request)],
        ...(request.maxLifetimeSeconds === undefined
          ? {}
          : { maxLifetimeSeconds: request.maxLifetimeSeconds }),
        ...(network === undefined ? {} : { network }),
        ...(objectStorageAccess === undefined ? {} : { objectStorageAccess }),
        ...(runnerIds.length === 0 ? {} : { mode: SandboxMode.CKS, runnerIds }),
        primaryContainer: PRIMARY_CONTAINER,
        services: toProtoServices(request.services),
        tags: [...(request.tags ?? [])],
        ...(volumes === undefined ? {} : { volumes }),
      }),
    }),
  });
}

function toProtoContainer(request: StartSandboxRequest): ReturnType<typeof Container.create> {
  const resourceRequirements = toProtoResourceRequirements(request.resources);
  const volumeMounts = toProtoVolumeMounts(request);
  return Container.create({
    args: commandArgs(request.command),
    command: commandName(request.command),
    environmentVariables: { ...request.environmentVariables },
    files: normalizeMountedFiles(request.mountedFiles).map((file) => ({
      content: normalizeFileContent(file.content),
      path: file.path,
    })),
    image: request.containerImage ?? DEFAULT_CONTAINER_IMAGE,
    name: PRIMARY_CONTAINER,
    ...(resourceRequirements === undefined ? {} : { resourceRequirements }),
    secretStores: groupSecretsByStore(normalizeSecrets(request.secrets)).map((group) => ({
      secrets: group.secrets.map((secret) => ({
        envVar: secret.envVar,
        field: secret.field,
        path: secret.name,
      })),
      storeName: group.store,
    })),
    ...(volumeMounts === undefined ? {} : { volumeMounts }),
  });
}

function scratchVolumesFromRequest(
  request: StartSandboxRequest,
): readonly ScratchVolumeOptions[] | undefined {
  if (request.volumes !== undefined) {
    return request.volumes;
  }
  if (request.fileSystemSnapshot === undefined) {
    return undefined;
  }
  return [
    {
      name: DEFAULT_SCRATCH_VOLUME_NAME,
      mountPath: request.fileSystemSnapshot.mountPath,
      ...(request.fileSystemSnapshot.size === undefined
        ? {}
        : { size: request.fileSystemSnapshot.size }),
      ...(request.fileSystemSnapshot.restoreFromSnapshotId === undefined
        ? {}
        : { restoreFromSnapshotId: request.fileSystemSnapshot.restoreFromSnapshotId }),
    },
  ];
}

function toProtoScratchSource(
  options: ScratchVolumeOptions,
): ReturnType<typeof ScratchVolume.create> {
  const size = options.size === undefined || options.size === "" ? undefined : options.size;
  const restoreFromSnapshotId =
    options.restoreFromSnapshotId === undefined || options.restoreFromSnapshotId === ""
      ? undefined
      : options.restoreFromSnapshotId;
  return ScratchVolume.create({
    ...(size === undefined ? {} : { size }),
    ...(restoreFromSnapshotId === undefined ? {} : { restoreFromSnapshotId }),
  });
}

function toProtoVolumes(
  request: StartSandboxRequest,
): ReturnType<typeof SandboxVolume.create>[] | undefined {
  const volumes = scratchVolumesFromRequest(request);
  if (volumes === undefined) {
    return undefined;
  }

  return volumes.map((volume) =>
    SandboxVolume.create({
      name: volume.name,
      source: {
        oneofKind: "scratch",
        scratch: toProtoScratchSource(volume),
      },
    }),
  );
}

function toProtoVolumeMounts(
  request: StartSandboxRequest,
): ReturnType<typeof VolumeMount.create>[] | undefined {
  const volumes = scratchVolumesFromRequest(request);
  if (volumes === undefined) {
    return undefined;
  }

  return volumes.map((volume) =>
    VolumeMount.create({
      mountPath: volume.mountPath,
      volume: volume.name,
    }),
  );
}

function toProtoObjectStorageAccess(
  access: SandboxObjectStorageAccess | undefined,
): ReturnType<typeof ObjectStorageAccess.create> | undefined {
  if (access === undefined) {
    return undefined;
  }

  const objectPrefix =
    access.objectPrefix === undefined || access.objectPrefix === ""
      ? undefined
      : access.objectPrefix;
  return ObjectStorageAccess.create({
    buckets: [...access.buckets],
    permission:
      access.permission === "read-write"
        ? ObjectStoragePermission.READ_WRITE
        : ObjectStoragePermission.READ,
    ...(objectPrefix === undefined ? {} : { objectPrefix }),
  });
}

function toProtoNetwork(
  network: NetworkOptions | undefined,
): ReturnType<typeof ProtoNetworkOptions.create> | undefined {
  if (network === undefined) {
    return undefined;
  }
  if (network.denyEgress === undefined && network.denyIngress === undefined) {
    return undefined;
  }

  return ProtoNetworkOptions.create({
    ...(network.denyEgress !== undefined ? { denyEgress: network.denyEgress } : {}),
    ...(network.denyIngress !== undefined ? { denyIngress: network.denyIngress } : {}),
  });
}

function toProtoServices(
  services: readonly Service[] | undefined,
): ReturnType<typeof ProtoService.create>[] {
  return (services ?? []).map((service) =>
    ProtoService.create({
      ...(service.name === undefined ? {} : { name: service.name }),
      port: service.port,
      protocol: toProtoServiceProtocol(service.protocol),
      visibility: toProtoVisibility(service.visibility),
      ...(service.endpoint === undefined
        ? {}
        : {
            endpoint: {
              auth: EndpointAuth.OPEN,
              kind: EndpointKind.HTTPS,
            },
          }),
    }),
  );
}

function toProtoServiceProtocol(protocol: string | undefined): ServiceProtocol {
  switch (protocol?.trim().toLowerCase()) {
    case "tcp":
      return ServiceProtocol.TCP;
    case "udp":
      return ServiceProtocol.UDP;
    case "sctp":
      return ServiceProtocol.SCTP;
    default:
      return ServiceProtocol.UNSPECIFIED;
  }
}

function toProtoVisibility(visibility: string | undefined): Visibility {
  switch (visibility?.trim().toLowerCase()) {
    case "public":
      return Visibility.PUBLIC;
    case "private":
      return Visibility.PRIVATE;
    case "custom":
      return Visibility.CUSTOM;
    default:
      return Visibility.UNSPECIFIED;
  }
}

function toProtoResourceRequirements(
  resources: ResourceOptions | undefined,
): ReturnType<typeof ResourceRequirements.create> | undefined {
  if (resources === undefined) {
    return undefined;
  }

  if (isAdvancedResources(resources)) {
    return ResourceRequirements.create({
      limits: toProtoResources(resources.limits),
      requests: toProtoResources(resources.requests),
    });
  }

  const spec = toProtoResources(resources);
  return ResourceRequirements.create({
    limits: spec,
    requests: spec,
  });
}

function toProtoResources(spec: ResourceSpec): ReturnType<typeof Resources.create> {
  return Resources.create({
    cpu: spec.cpu ?? "",
    memory: spec.memory ?? "",
  });
}

export function toProtoExecRequest(
  request: ExecRequest,
): ReturnType<typeof ProtoExecRequest.create> {
  return ProtoExecRequest.create({
    command: toExecCommand(request),
    sandboxId: request.sandboxId,
  });
}

export function toProtoListSandboxesRequest(
  request: ListSandboxesOptions,
): ReturnType<typeof ListSandboxesRequest.create> {
  return ListSandboxesRequest.create({
    pageSize: request.pageSize ?? 0,
    pageToken: request.pageToken ?? "",
    runnerIds: [...(request.runnerIds ?? [])],
    showTerminated: request.showTerminated ?? false,
    state: toProtoState(request.status),
    tags: [...(request.tags ?? [])],
  });
}

export function toProtoDeleteRequest(request: {
  readonly allowMissing?: boolean;
  readonly gracefulShutdownSeconds?: number;
  readonly sandboxId: string;
}): ReturnType<typeof DeleteSandboxRequest.create> {
  return DeleteSandboxRequest.create({
    allowMissing: request.allowMissing === true,
    gracePeriodSeconds: request.gracefulShutdownSeconds ?? 0,
    sandboxId: request.sandboxId,
  });
}

export function toProtoStreamLogsRequest(request: {
  readonly follow?: boolean;
  readonly resume?: { readonly offset: bigint | number | string; readonly sessionId: string };
  readonly sandboxId: string;
  readonly sinceTime?: Date | string;
  readonly tailLines?: number;
  readonly timestamps?: boolean;
}): ReturnType<typeof ProtoStreamLogsRequest.create> {
  return ProtoStreamLogsRequest.create({
    follow: request.follow ?? false,
    ...(request.resume === undefined
      ? {}
      : {
          resumeLogOffset: String(request.resume.offset),
          resumeLogSessionId: request.resume.sessionId,
        }),
    sandboxId: request.sandboxId,
    ...(request.sinceTime === undefined ? {} : { sinceTime: toProtoTimestamp(request.sinceTime) }),
    tailLines: request.tailLines ?? 0,
    timestamps: request.timestamps ?? false,
  });
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

export function toSdkStartSandboxResult(sandbox: ProtoSandboxMessage): StartSandboxResult {
  return toSdkSandboxMetadata(sandbox);
}

export function toSdkGetSandboxResult(sandbox: ProtoSandboxMessage): GetSandboxResult {
  return {
    ...toSdkSandboxMetadata(sandbox),
    status: toSdkSandboxStatus(sandbox.status?.state ?? State.UNSPECIFIED),
  };
}

export function toSdkListSandboxesResult(response: {
  readonly nextPageToken: string;
  readonly sandboxes: readonly ProtoSandboxMessage[];
}): ListSandboxesResult {
  return {
    ...(response.nextPageToken === "" ? {} : { nextPageToken: response.nextPageToken }),
    sandboxes: response.sandboxes.map(toSdkSandboxInfo),
  };
}

export function toSdkSandboxInfo(sandbox: ProtoSandboxMessage): SandboxInfo {
  return {
    ...toSdkSandboxMetadata(sandbox),
    status: toSdkSandboxStatus(sandbox.status?.state ?? State.UNSPECIFIED),
  };
}

function toSdkSandboxMetadata(sandbox: ProtoSandboxMessage): StartSandboxResult {
  const status = sandbox.status;
  const exposedPorts = toSdkExposedPorts(status?.services);
  const serviceUrls = toSdkServiceUrls(status?.services);
  const resourceLimits = toSdkResourceSpec(
    status?.effectiveResourceRequirements?.limits ?? status?.effectiveResources,
  );
  const resourceRequests = toSdkResourceSpec(
    status?.effectiveResourceRequirements?.requests ?? status?.effectiveResources,
  );
  const startedAt = toDate(status?.startTime);

  return {
    ...(status?.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    ...(exposedPorts === undefined ? {} : { exposedPorts }),
    ...(resourceLimits === undefined ? {} : { resourceLimits }),
    ...(resourceRequests === undefined ? {} : { resourceRequests }),
    ...(status?.runnerGroupId === undefined || status.runnerGroupId === ""
      ? {}
      : { runnerGroupId: status.runnerGroupId }),
    ...(status?.runnerId === undefined || status.runnerId === ""
      ? {}
      : { runnerId: status.runnerId }),
    sandboxId: sandbox.sandboxId,
    ...(serviceUrls === undefined ? {} : { serviceUrls }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(status === undefined ? {} : { status: toSdkSandboxStatus(status.state) }),
    ...(status?.stateReason === undefined || status.stateReason === ""
      ? {}
      : { statusReason: status.stateReason }),
  };
}

function toSdkServiceUrls(
  services: readonly ProtoServiceStatus[] | undefined,
): readonly ServiceUrl[] | undefined {
  if (services === undefined || services.length === 0) {
    return undefined;
  }

  const urls = services.flatMap((service) => {
    const url = service.url || service.endpoint?.url || "";
    return url === "" ? [] : [{ name: service.name, port: service.port, url }];
  });

  return urls.length === 0 ? undefined : urls;
}

function toSdkExposedPorts(
  services: readonly ProtoServiceStatus[] | undefined,
): readonly SandboxExposedPort[] | undefined {
  if (services === undefined || services.length === 0) {
    return undefined;
  }

  const ports = services
    .filter((service) => service.visibility !== Visibility.UNSPECIFIED)
    .map((service) => {
      const protocol = protocolName(service.protocol);
      return {
        ...(service.name === "" ? {} : { name: service.name }),
        port: service.port,
        ...(protocol === undefined ? {} : { protocol }),
      };
    });

  return ports.length === 0 ? undefined : ports;
}

function protocolName(protocol: ServiceProtocol): string | undefined {
  switch (protocol) {
    case ServiceProtocol.TCP:
      return "TCP";
    case ServiceProtocol.UDP:
      return "UDP";
    case ServiceProtocol.SCTP:
      return "SCTP";
    default:
      return undefined;
  }
}

function toSdkResourceSpec(resource: Resources | undefined): ResourceSpec | undefined {
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

export function toSdkSandboxStatus(status: State): SandboxStatus {
  switch (status) {
    case State.PENDING:
      return "pending";
    case State.CREATING:
      return "creating";
    case State.RUNNING:
      return "running";
    case State.PAUSED:
      return "paused";
    case State.TERMINATING:
      return "terminating";
    case State.COMPLETED:
      return "completed";
    case State.FAILED:
      return "failed";
    case State.TERMINATED:
      return "terminated";
    case State.UNSPECIFIED:
      return "unspecified";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Unhandled sandbox status: ${_exhaustiveCheck}`);
    }
  }
}

export function toSdkFileSystemSnapshot(
  snapshot: ProtoFileSystemSnapshot,
): FileSystemSnapshotResult {
  const sizeBytes = parseSizeBytes(snapshot.sizeBytes);
  const createdAt = toDate(snapshot.createTime);
  const updatedAt = toDate(snapshot.updatedAt);
  const completedAt = toDate(snapshot.completeTime);
  return {
    snapshotId: snapshot.fileSystemSnapshotId,
    state: toSdkSnapshotState(snapshot.state),
    trigger: toSdkSnapshotTrigger(snapshot.trigger),
    ...(snapshot.stateReason === "" ? {} : { stateReason: snapshot.stateReason }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(snapshot.objectBucket === "" ? {} : { objectBucket: snapshot.objectBucket }),
    ...(snapshot.sourceSandboxId === "" ? {} : { sourceSandboxId: snapshot.sourceSandboxId }),
    ...(snapshot.sourceVolumeName === "" ? {} : { sourceVolumeName: snapshot.sourceVolumeName }),
    ...(snapshot.requestId === "" ? {} : { requestId: snapshot.requestId }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function toSdkSnapshotState(state: SnapshotState): FileSystemSnapshotState {
  switch (state) {
    case SnapshotState.CREATING:
      return "creating";
    case SnapshotState.READY:
      return "ready";
    case SnapshotState.FAILED:
      return "failed";
    case SnapshotState.DELETING:
      return "deleting";
    case SnapshotState.UNSPECIFIED:
      return "unspecified";
    default: {
      const _exhaustiveCheck: never = state;
      throw new Error(`Unhandled snapshot state: ${_exhaustiveCheck}`);
    }
  }
}

function toSdkSnapshotTrigger(trigger: SnapshotTrigger): FileSystemSnapshotTrigger {
  switch (trigger) {
    case SnapshotTrigger.MANUAL:
      return "manual";
    case SnapshotTrigger.ON_DELETE:
      return "on_delete";
    case SnapshotTrigger.UNSPECIFIED:
      return "unspecified";
    default: {
      const _exhaustiveCheck: never = trigger;
      throw new Error(`Unhandled snapshot trigger: ${_exhaustiveCheck}`);
    }
  }
}

function parseSizeBytes(value: string): number | undefined {
  if (value === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    return undefined;
  }

  return parsed;
}

function toProtoState(status: SandboxStatus | undefined): State {
  switch (status) {
    case undefined:
    case "unspecified":
      return State.UNSPECIFIED;
    case "pending":
      return State.PENDING;
    case "creating":
      return State.CREATING;
    case "running":
      return State.RUNNING;
    case "paused":
      return State.PAUSED;
    case "terminating":
      return State.TERMINATING;
    case "completed":
      return State.COMPLETED;
    case "failed":
      return State.FAILED;
    case "terminated":
      return State.TERMINATED;
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Unhandled sandbox status: ${_exhaustiveCheck}`);
    }
  }
}

function toExecCommand(request: ExecRequest): string[] {
  return commandForWorkingDirectory(request.command, request.cwd);
}

function toProtoTimestamp(value: Date | string): ProtoTimestamp {
  const date = value instanceof Date ? value : new Date(value);
  const millis = date.getTime();
  const seconds = Math.floor(millis / 1000);

  return {
    nanos: (millis - seconds * 1000) * 1_000_000,
    seconds: String(seconds),
  };
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
