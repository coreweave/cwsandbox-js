// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { randomUUID } from "node:crypto";

import { DEFAULT_SCRATCH_VOLUME_NAME } from "../../defaults.js";
import { CWSandboxValidationError } from "../../errors.js";
import { commandForWorkingDirectory } from "../../internal/commands.js";
import { normalizeFileContent, normalizeMountedFiles } from "../../internal/mounted-files.js";
import { isHttps443, isHttpsOnlyPorts, normalizeDnsName } from "../../internal/network.js";
import { isAdvancedResources } from "../../internal/resources.js";
import { groupSecretsByStore, normalizeSecrets } from "../../internal/secrets.js";
import { isRegisteredVolume } from "../../internal/validation/file-system-snapshot.js";
import type { Command, ProcessResult } from "../../public/commands.js";
import type { Container as SdkContainer } from "../../public/containers.js";
import type { MountedFiles } from "../../public/files.js";
import type {
  NetworkConfigResult,
  NetworkConfigUnsupportedField,
  NetworkConfigUpdateField,
} from "../../public/network-config.js";
import type {
  CidrBlock as SdkCidrBlock,
  DnsEgressMode,
  EffectiveEgressRule,
  EffectiveIngressRule,
  EgressRule,
  Endpoint,
  EndpointAuth as SdkEndpointAuth,
  HttpsEndpointStatus,
  IngressRule,
  NetworkOptions,
  PortRange as SdkPortRange,
  Service,
  ServiceProtocol as SdkServiceProtocol,
  ServiceUrl,
  TenantScope as SdkTenantScope,
  TlsPassthroughEndpointStatus,
} from "../../public/network.js";
import type { GpuSpec, ResourceOptions, ResourceSpec } from "../../public/resources.js";
import type {
  FileSystemSnapshotResult,
  FileSystemSnapshotState,
  FileSystemSnapshotTrigger,
  GetSandboxResult,
  ImagePullCredentials as SdkImagePullCredentials,
  ListSandboxesOptions,
  ListSandboxesResult,
  SandboxContainerStatus,
  SandboxControl,
  SandboxExposedPort,
  SandboxInfo,
  SandboxMetadata,
  SandboxObjectStorageAccess,
  SandboxStatus,
  ScratchVolumeOptions,
  SecurityContext as SdkSecurityContext,
  StartSandboxResult,
} from "../../public/sandbox.js";
import type { SecretInput, Secrets } from "../../public/secrets.js";
import type {
  CreateNetworkConfigRequest,
  ExecRequest,
  UpdateNetworkConfigRequest,
  StartSandboxFromFileRequest,
  StartSandboxFromTemplateRequest,
  StartSandboxRequest,
} from "../../transport/types.js";
import {
  CreateNetworkConfigRequest as ProtoCreateNetworkConfigRequest,
  NetworkConfig as ProtoNetworkConfig,
  UpdateNetworkConfigRequest as ProtoUpdateNetworkConfigRequest,
} from "./generated/coreweave/sandbox/v1/network_config.js";
import {
  Container,
  Control,
  CreateSandboxFromFileRequest,
  DNSEgressMode,
  CreateSandboxFromTemplateRequest,
  CreateSandboxRequest,
  DeleteSandboxRequest,
  EgressRule as ProtoEgressRule,
  EndpointAuth,
  EndpointKind,
  ExecRequest as ProtoExecRequest,
  ImagePullCredentials as ProtoImagePullCredentials,
  IngressRule as ProtoIngressRule,
  ListSandboxesRequest,
  NetworkOptions as ProtoNetworkOptions,
  ObjectStorageAccess,
  ObjectStoragePermission,
  PartialContainer,
  PartialSandboxSpec,
  PortRange as ProtoPortRange,
  ResourceRequirements,
  Resources,
  Sandbox as ProtoSandbox,
  SandboxFileType,
  SandboxMode,
  SandboxSpec,
  SandboxVolume,
  ScratchVolume,
  SecurityContext as ProtoSecurityContext,
  Service as ProtoService,
  ServiceProtocol,
  SnapshotState,
  SnapshotTrigger,
  State,
  StreamLogsRequest as ProtoStreamLogsRequest,
  TenantScope,
  Visibility,
  VolumeMount,
  type CidrBlock as ProtoCidrBlock,
  type ContainerStatus as ProtoContainerStatus,
  type Container as ProtoContainer,
  type ExecResponse as ProtoExecResponse,
  type FileSystemSnapshot as ProtoFileSystemSnapshot,
  type Gpu,
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
    requestId: request.requestId ?? randomUUID(),
    sandbox: ProtoSandbox.create({
      ...(request.displayName ? { displayName: request.displayName } : {}),
      spec: SandboxSpec.create({
        annotations: { ...request.annotations },
        containers:
          request.containers === undefined
            ? [toProtoContainer(request)]
            : toProtoContainers(request.containers, request),
        ...(request.maxLifetimeSeconds === undefined
          ? {}
          : { maxLifetimeSeconds: request.maxLifetimeSeconds }),
        ...(network === undefined ? {} : { network }),
        ...(request.networkConfigId === undefined
          ? {}
          : { networkConfigId: request.networkConfigId }),
        ...(objectStorageAccess === undefined ? {} : { objectStorageAccess }),
        ...(runnerIds.length === 0 ? {} : { mode: SandboxMode.CKS, runnerIds }),
        ...(request.runtimeClass ? { runtimeClass: request.runtimeClass } : {}),
        services: toProtoServices(request.services),
        tags: [...(request.tags ?? [])],
        ...(volumes === undefined ? {} : { volumes }),
      }),
    }),
  });
}

export function toProtoCreateFromFileRequest(
  request: StartSandboxFromFileRequest,
): CreateSandboxFromFileRequest {
  const runnerIds = [...(request.runnerIds ?? [])];
  const network = toProtoNetwork(request.network);
  const objectStorageAccess = toProtoObjectStorageAccess(request.objectStorageAccess);
  const defaultResources = toProtoResourceRequirements(request.defaultResources);
  const imageOverrides =
    request.imageOverrides !== undefined && Object.keys(request.imageOverrides).length > 0
      ? { ...request.imageOverrides }
      : undefined;

  const control = toProtoControl(request.control);
  const imagePullCredentials = request.imagePullCredentials?.map(toProtoImagePullCredentials);

  return CreateSandboxFromFileRequest.create({
    requestId: request.requestId ?? randomUUID(),
    type: SandboxFileType.COMPOSE,
    contents: request.contents,
    ...(request.primaryService === undefined ? {} : { primaryService: request.primaryService }),
    ...(control === undefined ? {} : { control }),
    ...(imagePullCredentials === undefined || imagePullCredentials.length === 0
      ? {}
      : { imagePullCredentials }),
    ...(imageOverrides === undefined ? {} : { imageOverrides }),
    ...(defaultResources === undefined ? {} : { defaultResources }),
    ...(request.maxLifetimeSeconds === undefined
      ? {}
      : { maxLifetimeSeconds: request.maxLifetimeSeconds }),
    ...(network === undefined ? {} : { network }),
    ...(objectStorageAccess === undefined ? {} : { objectStorageAccess }),
    annotations: { ...request.annotations },
    ...(request.displayName ? { displayName: request.displayName } : {}),
    tags: [...(request.tags ?? [])],
    ...(runnerIds.length === 0 ? {} : { mode: SandboxMode.CKS, runnerIds }),
  });
}

function toProtoControl(control: SandboxControl | undefined): Control | undefined {
  switch (control) {
    case "platform":
      return Control.PLATFORM;
    case "container_engine":
      return Control.CONTAINER_ENGINE;
    default:
      return undefined;
  }
}

function toProtoImagePullCredentials(
  credentials: SdkImagePullCredentials,
): ProtoImagePullCredentials {
  return ProtoImagePullCredentials.create({
    registry: credentials.registry,
    credentials: {
      field: credentials.field ?? "",
      path: credentials.name,
      storeName: credentials.store,
    },
  });
}

export function toProtoCreateFromTemplateRequest(
  request: StartSandboxFromTemplateRequest,
): CreateSandboxFromTemplateRequest {
  const overrides = PartialSandboxSpec.create();
  let hasOverride = false;

  if (request.annotations !== undefined && Object.keys(request.annotations).length > 0) {
    overrides.annotations = { ...request.annotations };
    hasOverride = true;
  }

  if (request.containerImage !== undefined) {
    overrides.containers = [toProtoPartialContainer(request)];
    hasOverride = true;
    const volumes = toProtoVolumes(request);
    if (volumes !== undefined) {
      overrides.volumes = volumes;
    }
  }

  if (request.maxLifetimeSeconds !== undefined && request.maxLifetimeSeconds !== 0) {
    overrides.maxLifetimeSeconds = request.maxLifetimeSeconds;
    hasOverride = true;
  }

  if (request.network !== undefined) {
    overrides.network = toProtoNetwork(request.network) ?? ProtoNetworkOptions.create();
    hasOverride = true;
  }

  if (request.networkConfigId !== undefined) {
    overrides.networkConfigId = request.networkConfigId;
    hasOverride = true;
  }

  if (request.runnerIds !== undefined && request.runnerIds.length > 0) {
    overrides.mode = SandboxMode.CKS;
    overrides.runnerIds = [...request.runnerIds];
    hasOverride = true;
  }

  if (request.services !== undefined && request.services.length > 0) {
    overrides.services = toProtoServices(request.services);
    hasOverride = true;
  }

  if (request.tags !== undefined && request.tags.length > 0) {
    overrides.tags = [...request.tags];
    hasOverride = true;
  }

  return CreateSandboxFromTemplateRequest.create({
    requestId: randomUUID(),
    templateId: request.templateId,
    ...(request.displayName ? { displayName: request.displayName } : {}),
    ...(hasOverride ? { overrides } : {}),
  });
}

function toProtoPartialContainer(
  request: StartSandboxFromTemplateRequest,
): ReturnType<typeof PartialContainer.create> {
  const resourceRequirements = toProtoResourceRequirements(request.resources);
  const volumeMounts = toProtoVolumeMounts(request);
  const environmentVariables =
    request.environmentVariables !== undefined &&
    Object.keys(request.environmentVariables).length > 0
      ? { ...request.environmentVariables }
      : undefined;
  const files =
    request.mountedFiles === undefined
      ? undefined
      : normalizeMountedFiles(request.mountedFiles).map((file) => ({
          content: normalizeFileContent(file.content),
          path: file.path,
        }));
  const secretStores =
    request.secrets === undefined
      ? undefined
      : groupSecretsByStore(normalizeSecrets(request.secrets)).map((group) => ({
          secrets: group.secrets.map((secret) => ({
            envVar: secret.envVar,
            field: secret.field,
            path: secret.name,
          })),
          storeName: group.store,
        }));

  return PartialContainer.create({
    ...(request.command === undefined
      ? {}
      : {
          command: commandName(request.command),
          ...(request.command.length > 1 ? { args: commandArgs(request.command) } : {}),
        }),
    ...(environmentVariables === undefined ? {} : { environmentVariables }),
    ...(files === undefined ? {} : { files }),
    image: request.containerImage ?? "",
    name: PRIMARY_CONTAINER,
    primary: true,
    ...(resourceRequirements === undefined ? {} : { resourceRequirements }),
    ...(secretStores === undefined ? {} : { secretStores }),
    ...(volumeMounts === undefined ? {} : { volumeMounts }),
  });
}

function toProtoContainer(request: StartSandboxRequest): ReturnType<typeof Container.create> {
  const resourceRequirements = toProtoResourceRequirements(request.resources);
  const volumeMounts = toProtoVolumeMounts(request);
  return Container.create({
    ...(request.command === undefined
      ? {}
      : { args: commandArgs(request.command), command: commandName(request.command) }),
    environmentVariables: { ...request.environmentVariables },
    files: toProtoFileMounts(request.mountedFiles),
    image: request.containerImage ?? DEFAULT_CONTAINER_IMAGE,
    ...(request.imagePullCredentials === undefined
      ? {}
      : { imagePullCredentials: toProtoImagePullCredentials(request.imagePullCredentials) }),
    name: PRIMARY_CONTAINER,
    primary: true,
    ...(resourceRequirements === undefined ? {} : { resourceRequirements }),
    secretStores: toProtoSecretStores(request.secrets),
    ...(request.securityContext === undefined
      ? {}
      : { securityContext: toProtoSecurityContext(request.securityContext) }),
    ...(volumeMounts === undefined ? {} : { volumeMounts }),
    ...(request.workingDir ? { workingDir: request.workingDir } : {}),
  });
}

function toProtoSecurityContext(
  context: SdkSecurityContext,
): ReturnType<typeof ProtoSecurityContext.create> {
  return ProtoSecurityContext.create({
    ...(context.runAsUser === undefined ? {} : { runAsUser: context.runAsUser }),
    ...(context.runAsGroup === undefined ? {} : { runAsGroup: context.runAsGroup }),
    ...(context.privileged === undefined ? {} : { privileged: context.privileged }),
    ...(context.allowPrivilegeEscalation === undefined
      ? {}
      : { allowPrivilegeEscalation: context.allowPrivilegeEscalation }),
    ...(context.readOnlyRootFilesystem === undefined
      ? {}
      : { readOnlyRootFilesystem: context.readOnlyRootFilesystem }),
    capabilitiesAdd: [...(context.capabilitiesAdd ?? [])],
    capabilitiesDrop: [...(context.capabilitiesDrop ?? [])],
    seccompProfile: context.seccompProfile ?? "",
  });
}

function toProtoContainers(
  containers: readonly SdkContainer[],
  volumes: VolumeCreateFields,
): ReturnType<typeof Container.create>[] {
  const rows = containers.map(toProtoUserContainer);
  // Sandbox-level volume mounts go on the primary, as with a single container.
  const mounts = toProtoVolumeMounts(volumes) ?? [];
  const primary = rows.find((row) => row.primary === true) ?? rows[0];
  if (primary !== undefined) {
    const existing = new Set(primary.volumeMounts.map((m) => `${m.volume}\0${m.mountPath}`));
    for (const mount of mounts) {
      if (!existing.has(`${mount.volume}\0${mount.mountPath}`)) {
        primary.volumeMounts.push(mount);
      }
    }
  }
  return rows;
}

function toProtoUserContainer(container: SdkContainer): ReturnType<typeof Container.create> {
  const resourceRequirements = toProtoResourceRequirements(container.resources);
  return Container.create({
    args: [...(container.args ?? [])],
    command: container.command ?? "",
    environmentVariables: { ...container.environmentVariables },
    files: toProtoFileMounts(container.mountedFiles),
    image: container.image,
    name: container.name ?? "",
    ...(container.primary === true ? { primary: true } : {}),
    ...(resourceRequirements === undefined ? {} : { resourceRequirements }),
    secretStores: toProtoSecretStores(container.secrets),
    volumeMounts: (container.volumeMounts ?? []).map((mount) =>
      VolumeMount.create({
        mountPath: mount.mountPath,
        readOnly: mount.readOnly === true,
        subPath: mount.subPath ?? "",
        volume: mount.volume,
      }),
    ),
  });
}

function toProtoFileMounts(
  mountedFiles: MountedFiles | undefined,
): { content: Uint8Array; path: string }[] {
  return normalizeMountedFiles(mountedFiles).map((file) => ({
    content: normalizeFileContent(file.content),
    path: file.path,
  }));
}

function toProtoSecretStores(secrets: Secrets | undefined): {
  secrets: { envVar: string; field: string; path: string }[];
  storeName: string;
}[] {
  return groupSecretsByStore(normalizeSecrets(secrets)).map((group) => ({
    secrets: group.secrets.map((secret) => ({
      envVar: secret.envVar,
      field: secret.field,
      path: secret.name,
    })),
    storeName: group.store,
  }));
}

type VolumeCreateFields = {
  readonly fileSystemSnapshot?: StartSandboxRequest["fileSystemSnapshot"];
  readonly volumes?: StartSandboxRequest["volumes"];
};

function volumesFromRequest(request: VolumeCreateFields): StartSandboxRequest["volumes"] {
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
  request: VolumeCreateFields,
): ReturnType<typeof SandboxVolume.create>[] | undefined {
  const volumes = volumesFromRequest(request);
  if (volumes === undefined) {
    return undefined;
  }

  return volumes.map((volume) =>
    SandboxVolume.create({
      name: volume.name,
      source: isRegisteredVolume(volume)
        ? { oneofKind: "volumeId", volumeId: volume.volumeId }
        : { oneofKind: "scratch", scratch: toProtoScratchSource(volume) },
    }),
  );
}

function toProtoVolumeMounts(
  request: VolumeCreateFields,
): ReturnType<typeof VolumeMount.create>[] | undefined {
  const volumes = volumesFromRequest(request);
  if (volumes === undefined) {
    return undefined;
  }

  return volumes.map((volume) =>
    VolumeMount.create({
      mountPath: volume.mountPath,
      volume: volume.name,
      ...(isRegisteredVolume(volume)
        ? { readOnly: volume.readOnly === true, subPath: volume.subPath ?? "" }
        : {}),
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

  const egress = toProtoEgress(network.egress);
  const ingress = toProtoIngress(network.ingress);
  if (
    network.denyEgress === undefined &&
    network.denyIngress === undefined &&
    network.dnsEgress === undefined &&
    egress === undefined &&
    ingress === undefined
  ) {
    return undefined;
  }

  return ProtoNetworkOptions.create({
    ...(network.denyEgress !== undefined ? { denyEgress: network.denyEgress } : {}),
    ...(network.denyIngress !== undefined ? { denyIngress: network.denyIngress } : {}),
    ...(network.dnsEgress !== undefined
      ? { dnsEgress: toProtoDnsEgressMode(network.dnsEgress) }
      : {}),
    ...(egress === undefined ? {} : { egress }),
    ...(ingress === undefined ? {} : { ingress }),
  });
}

function toProtoIngress(
  ingress: NetworkOptions["ingress"],
): ReturnType<typeof ProtoIngressRule.create>[] | undefined {
  if (ingress === undefined || ingress.length === 0) {
    return undefined;
  }

  return ingress.map((rule) =>
    ProtoIngressRule.create({
      source: toProtoIngressSource(rule),
      ports: toProtoPortRanges(rule.ports),
    }),
  );
}

function toProtoPortRanges(
  ports: readonly SdkPortRange[] | undefined,
): ReturnType<typeof ProtoPortRange.create>[] {
  return (ports ?? []).map((port) =>
    ProtoPortRange.create({
      port: port.port,
      ...(port.endPort === undefined ? {} : { endPort: port.endPort }),
      ...(port.protocol === undefined ? {} : { protocol: port.protocol }),
    }),
  );
}

function toProtoCidrBlock(block: SdkCidrBlock): ProtoCidrBlock {
  return { cidr: block.cidr, except: [...(block.exceptCidrs ?? [])] };
}

function toProtoIngressSource(rule: IngressRule): ProtoIngressRule["source"] {
  if (rule.cidr !== undefined) {
    return { oneofKind: "cidr", cidr: toProtoCidrBlock(rule.cidr) };
  }
  if (rule.tenant !== undefined) {
    return { oneofKind: "tenant", tenant: toProtoTenantScope(rule.tenant) };
  }
  return { oneofKind: "any", any: true };
}

function toProtoTenantScope(tenant: Exclude<SdkTenantScope, "unspecified">): TenantScope {
  switch (tenant) {
    case "same_user":
      return TenantScope.SAME_USER;
    case "same_org":
      return TenantScope.SAME_ORG;
    case "sandbox_network":
      return TenantScope.SANDBOX_NETWORK;
  }
}

function toProtoDnsEgressMode(mode: DnsEgressMode): DNSEgressMode {
  return mode === "deny" ? DNSEgressMode.DNS_EGRESS_MODE_DENY : DNSEgressMode.DNS_EGRESS_MODE_ALLOW;
}

function toSdkDnsEgressMode(mode: DNSEgressMode): DnsEgressMode | undefined {
  switch (mode) {
    case DNSEgressMode.DNS_EGRESS_MODE_ALLOW:
      return "allow";
    case DNSEgressMode.DNS_EGRESS_MODE_DENY:
      return "deny";
    default:
      return undefined;
  }
}

function toProtoEgress(
  egress: NetworkOptions["egress"],
): ReturnType<typeof ProtoEgressRule.create>[] | undefined {
  if (egress === undefined || egress.length === 0) {
    return undefined;
  }

  return egress.map((rule) =>
    ProtoEgressRule.create({
      destination: toProtoEgressDestination(rule),
      ports: toProtoPortRanges(rule.ports),
    }),
  );
}

function toProtoEgressDestination(rule: EgressRule): ProtoEgressRule["destination"] {
  if (rule.dnsName !== undefined) {
    return { oneofKind: "httpsHostname", httpsHostname: normalizeDnsName(rule.dnsName) };
  }
  if (rule.cidr !== undefined) {
    return { oneofKind: "cidr", cidr: toProtoCidrBlock(rule.cidr) };
  }
  if (rule.tenant !== undefined) {
    return { oneofKind: "tenant", tenant: toProtoTenantScope(rule.tenant) };
  }
  if (rule.selector !== undefined) {
    return {
      oneofKind: "selector",
      selector: {
        podLabels: { ...rule.selector.podLabels },
        namespaceLabels: { ...rule.selector.namespaceLabels },
      },
    };
  }
  return { oneofKind: "any", any: true };
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
      ...(service.endpoint === undefined ? {} : { endpoint: toProtoEndpoint(service.endpoint) }),
    }),
  );
}

function toProtoEndpoint(endpoint: Endpoint): {
  auth?: EndpointAuth;
  kind: EndpointKind;
  requestTimeoutSeconds?: number;
} {
  if (endpoint.kind === "tls_passthrough") {
    return { kind: EndpointKind.TLS_PASSTHROUGH };
  }
  const requestTimeout = endpoint.requestTimeoutSeconds
    ? { requestTimeoutSeconds: endpoint.requestTimeoutSeconds }
    : {};
  switch (endpoint.auth.trim().toLowerCase()) {
    case "share_token":
      return { auth: EndpointAuth.SHARE_TOKEN, kind: EndpointKind.HTTPS, ...requestTimeout };
    case "open":
      return { auth: EndpointAuth.OPEN, kind: EndpointKind.HTTPS, ...requestTimeout };
    default:
      throw new CWSandboxValidationError("Service.endpoint.auth must be open or share_token");
  }
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

  // GPU is not a burst dimension, so it goes on both sides, as in the Python SDK.
  if (isAdvancedResources(resources)) {
    return ResourceRequirements.create({
      limits: toProtoResources(resources.limits, resources.gpu),
      requests: toProtoResources(resources.requests, resources.gpu),
    });
  }

  const spec = toProtoResources(resources, resources.gpu);
  return ResourceRequirements.create({
    limits: spec,
    requests: spec,
  });
}

function toProtoResources(
  spec: Omit<ResourceSpec, "gpu">,
  gpu: GpuSpec | undefined,
): ReturnType<typeof Resources.create> {
  return Resources.create({
    cpu: spec.cpu ?? "",
    memory: spec.memory ?? "",
    ...(gpu === undefined ? {} : { gpu: toProtoGpu(gpu) }),
  });
}

function toProtoGpu(gpu: GpuSpec): Gpu {
  return {
    count: String(gpu.count),
    selector:
      gpu.type !== undefined
        ? { oneofKind: "type", type: gpu.type }
        : gpu.memoryGb !== undefined
          ? { oneofKind: "memoryGb", memoryGb: String(gpu.memoryGb) }
          : { oneofKind: undefined },
  };
}

/** Empty or whitespace targets the primary. */
export function toProtoContainerTarget(container: string | undefined): string {
  return container?.trim() ?? "";
}

export function toProtoExecRequest(
  request: ExecRequest,
): ReturnType<typeof ProtoExecRequest.create> {
  return ProtoExecRequest.create({
    command: toExecCommand(request),
    container: toProtoContainerTarget(request.container),
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
    volumeIds: [...(request.volumeIds ?? [])],
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
  readonly container?: string;
  readonly follow?: boolean;
  readonly resume?: { readonly offset: bigint | number | string; readonly sessionId: string };
  readonly sandboxId: string;
  readonly sinceTime?: Date | string;
  readonly tailLines?: number;
  readonly timestamps?: boolean;
}): ReturnType<typeof ProtoStreamLogsRequest.create> {
  return ProtoStreamLogsRequest.create({
    container: toProtoContainerTarget(request.container),
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
  const metadata = toSdkSandboxMetadata(sandbox);
  const token = sandbox.endpointShareToken;
  return {
    ...metadata,
    ...(token === undefined || token === "" ? {} : { endpointShareToken: token }),
  };
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

function toSdkSandboxMetadata(sandbox: ProtoSandboxMessage): SandboxMetadata {
  const status = sandbox.status;
  const exposedPorts = toSdkExposedPorts(status?.services);
  const serviceAddresses = toSdkServiceAddresses(status?.services);
  const serviceEndpoints = toSdkServiceEndpoints(status?.services);
  const serviceUrls = toSdkServiceUrls(status?.services);
  const resourceLimits = toSdkResourceSpec(
    status?.effectiveResourceRequirements?.limits ?? status?.effectiveResources,
  );
  const resourceRequests = toSdkResourceSpec(
    status?.effectiveResourceRequirements?.requests ?? status?.effectiveResources,
  );
  const startedAt = toDate(status?.startTime);
  const createdAt = toDate(status?.createTime);
  const dnsEgressNames = toSdkDnsEgressNames(status?.effectiveEgress);
  const containerStatuses = toSdkContainerStatuses(status?.containerStatuses);
  const effectiveEgress = toSdkEffectiveEgress(status?.effectiveEgress);
  const effectiveIngress = toSdkEffectiveIngress(status?.effectiveIngress);
  const effectiveDnsEgress =
    status === undefined ? undefined : toSdkDnsEgressMode(status.effectiveDnsEgress);
  const networkConfigId = sandbox.spec?.networkConfigId;
  const containers = toSdkContainers(sandbox.spec?.containers);

  return {
    ...(sandbox.spec === undefined ? {} : { tags: [...sandbox.spec.tags] }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(sandbox.control === Control.UNSPECIFIED
      ? {}
      : { control: toSdkSandboxControl(sandbox.control) }),
    ...(status?.attachedVolumeIds === undefined || status.attachedVolumeIds.length === 0
      ? {}
      : { attachedVolumeIds: [...status.attachedVolumeIds] }),
    ...(containerStatuses === undefined ? {} : { containerStatuses }),
    ...(containers === undefined ? {} : { containers }),
    ...(sandbox.displayName === "" ? {} : { displayName: sandbox.displayName }),
    ...(status?.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    ...(dnsEgressNames === undefined ? {} : { dnsEgressNames }),
    ...(effectiveEgress === undefined ? {} : { effectiveEgress }),
    ...(effectiveIngress === undefined ? {} : { effectiveIngress }),
    ...(status?.effectiveRuntimeClass === undefined || status.effectiveRuntimeClass === ""
      ? {}
      : { effectiveRuntimeClass: status.effectiveRuntimeClass }),
    ...(effectiveDnsEgress === undefined ? {} : { effectiveDnsEgress }),
    ...(exposedPorts === undefined ? {} : { exposedPorts }),
    ...(networkConfigId === undefined || networkConfigId === "" ? {} : { networkConfigId }),
    ...(resourceLimits === undefined ? {} : { resourceLimits }),
    ...(resourceRequests === undefined ? {} : { resourceRequests }),
    ...(status?.runnerGroupId === undefined || status.runnerGroupId === ""
      ? {}
      : { runnerGroupId: status.runnerGroupId }),
    ...(status?.runnerId === undefined || status.runnerId === ""
      ? {}
      : { runnerId: status.runnerId }),
    sandboxId: sandbox.sandboxId,
    ...(serviceAddresses === undefined ? {} : { serviceAddresses }),
    ...(serviceEndpoints === undefined ? {} : { serviceEndpoints }),
    ...(serviceUrls === undefined ? {} : { serviceUrls }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(status === undefined ? {} : { status: toSdkSandboxStatus(status.state) }),
    ...(status?.stateReason === undefined || status.stateReason === ""
      ? {}
      : { statusReason: status.stateReason }),
  };
}

/**
 * Marks the inferred primary so the list is a valid `containers` create
 * option. Not valid on engine sandboxes, which echo one image-less
 * `cws-engine` row. Proto fields `SdkContainer` does not model are dropped.
 */
function toSdkContainers(
  containers: readonly ProtoContainer[] | undefined,
): readonly SdkContainer[] | undefined {
  if (containers === undefined || containers.length === 0) {
    return undefined;
  }
  const rows = containers.map(toSdkContainer);
  if (rows.some((row) => row.primary === true)) {
    return rows;
  }
  return rows.map((row, index) => (index === 0 ? { ...row, primary: true } : row));
}

function toSdkContainer(container: ProtoContainer): SdkContainer {
  const resources = toSdkContainerResources(container);
  const secrets = container.secretStores.flatMap((store) =>
    store.secrets.map((secret): SecretInput => ({
      name: secret.path,
      store: store.storeName,
      ...(secret.field === "" ? {} : { field: secret.field }),
      ...(secret.envVar === "" ? {} : { envVar: secret.envVar }),
    })),
  );
  const environmentVariables = { ...container.environmentVariables };
  return {
    image: container.image,
    ...(container.name === "" ? {} : { name: container.name }),
    ...(container.command === "" ? {} : { command: container.command }),
    ...(container.args.length === 0 ? {} : { args: [...container.args] }),
    ...(Object.keys(environmentVariables).length === 0 ? {} : { environmentVariables }),
    ...(resources === undefined ? {} : { resources }),
    ...(container.files.length === 0
      ? {}
      : {
          mountedFiles: container.files.map((file) => ({ content: file.content, path: file.path })),
        }),
    ...(container.volumeMounts.length === 0
      ? {}
      : {
          volumeMounts: container.volumeMounts.map((mount) => ({
            mountPath: mount.mountPath,
            volume: mount.volume,
            ...(mount.readOnly ? { readOnly: true } : {}),
            ...(mount.subPath === "" ? {} : { subPath: mount.subPath }),
          })),
        }),
    ...(secrets.length === 0 ? {} : { secrets }),
    ...(container.primary === true ? { primary: true } : {}),
  };
}

function toSdkContainerResources(container: ProtoContainer): ResourceOptions | undefined {
  const requirements = container.resourceRequirements;
  if (requirements === undefined) {
    return toSdkResourceSpec(container.resources);
  }
  const requests = toSdkResourceSpec(requirements.requests);
  const limits = toSdkResourceSpec(requirements.limits);
  if (requests === undefined || limits === undefined) {
    return requests ?? limits;
  }
  if (requests.cpu === limits.cpu && requests.memory === limits.memory) {
    return requests;
  }
  // GPU is sent on both sides but set once, next to requests and limits, on create.
  const { gpu, ...requestSpec } = requests;
  const { gpu: limitGpu, ...limitSpec } = limits;
  const containerGpu = gpu ?? limitGpu;
  return {
    limits: limitSpec,
    requests: requestSpec,
    ...(containerGpu === undefined ? {} : { gpu: containerGpu }),
  };
}

function toSdkSandboxControl(control: Control): SandboxControl {
  switch (control) {
    case Control.PLATFORM:
      return "platform";
    case Control.CONTAINER_ENGINE:
      return "container_engine";
    default:
      return "unspecified";
  }
}

function toSdkDnsEgressNames(
  rules: readonly ProtoEgressRule[] | undefined,
): readonly string[] | undefined {
  if (rules === undefined || rules.length === 0) {
    return undefined;
  }

  const names = rules.flatMap((rule) => {
    if (rule.destination.oneofKind !== "httpsHostname") {
      return [];
    }
    const name = rule.destination.httpsHostname;
    return name === "" ? [] : [name];
  });

  return names.length === 0 ? undefined : names;
}

const TERMINAL_CONTAINER_STATUSES = new Set<SandboxStatus>(["completed", "failed", "terminated"]);

function toSdkContainerStatuses(
  rows: readonly ProtoContainerStatus[] | undefined,
): readonly SandboxContainerStatus[] | undefined {
  if (rows === undefined || rows.length === 0) {
    return undefined;
  }

  return rows.map((row) => {
    // A newer server may send a State this client does not know.
    const status = State[row.state] === undefined ? "unspecified" : toSdkSandboxStatus(row.state);
    return {
      name: row.name,
      status,
      ...(TERMINAL_CONTAINER_STATUSES.has(status) ? { exitCode: row.exitCode } : {}),
      restartCount: row.restartCount,
    };
  });
}

function toSdkEffectiveEgress(
  rules: readonly ProtoEgressRule[] | undefined,
): readonly EffectiveEgressRule[] | undefined {
  const mapped = (rules ?? []).flatMap((rule): EffectiveEgressRule[] => {
    let ports = toSdkPortRanges(rule.ports);
    const destination = rule.destination;
    switch (destination.oneofKind) {
      case "httpsHostname":
        // A hostname grant is HTTPS only; anything but one TCP 443 range is noise.
        if (ports !== undefined && !(ports.length === 1 && ports.every(isHttps443))) {
          ports = undefined;
        }
        return [{ dnsName: destination.httpsHostname, ...withPorts(ports) }];
      case "cidr":
        return [{ cidr: toSdkCidrBlock(destination.cidr), ...withPorts(ports) }];
      case "tenant":
        return [{ tenant: toSdkTenantScope(destination.tenant), ...withPorts(ports) }];
      case "any":
        return [{ any: true, ...withPorts(ports) }];
      case "selector": {
        const { namespaceLabels, podLabels } = destination.selector;
        return [
          {
            selector: {
              podLabels: { ...podLabels },
              ...(Object.keys(namespaceLabels).length === 0
                ? {}
                : { namespaceLabels: { ...namespaceLabels } }),
            },
            ...withPorts(ports),
          },
        ];
      }
      default:
        return [];
    }
  });
  return mapped.length === 0 ? undefined : mapped;
}

function toSdkEffectiveIngress(
  rules: readonly ProtoIngressRule[] | undefined,
): readonly EffectiveIngressRule[] | undefined {
  const mapped = (rules ?? []).flatMap((rule): EffectiveIngressRule[] => {
    const ports = withPorts(toSdkPortRanges(rule.ports));
    const source = rule.source;
    switch (source.oneofKind) {
      case "cidr":
        return [{ cidr: toSdkCidrBlock(source.cidr), ...ports }];
      case "tenant":
        return [{ tenant: toSdkTenantScope(source.tenant), ...ports }];
      case "any":
        return [{ any: true, ...ports }];
      default:
        return [];
    }
  });
  return mapped.length === 0 ? undefined : mapped;
}

function withPorts(ports: readonly SdkPortRange[] | undefined): {
  readonly ports?: readonly SdkPortRange[];
} {
  return ports === undefined ? {} : { ports };
}

function toSdkPortRanges(ports: readonly ProtoPortRange[]): readonly SdkPortRange[] | undefined {
  if (ports.length === 0) {
    return undefined;
  }
  return ports.map((port) => ({
    port: port.port,
    ...(port.endPort === 0 ? {} : { endPort: port.endPort }),
    ...(port.protocol === "" ? {} : { protocol: port.protocol }),
  }));
}

function toSdkCidrBlock(block: ProtoCidrBlock): SdkCidrBlock {
  return {
    cidr: block.cidr,
    ...(block.except.length === 0 ? {} : { exceptCidrs: [...block.except] }),
  };
}

function toSdkTenantScope(scope: TenantScope): SdkTenantScope {
  switch (scope) {
    case TenantScope.SAME_USER:
      return "same_user";
    case TenantScope.SAME_ORG:
      return "same_org";
    case TenantScope.SANDBOX_NETWORK:
      return "sandbox_network";
    default:
      return "unspecified";
  }
}

function toSdkServiceUrls(
  services: readonly ProtoServiceStatus[] | undefined,
): readonly ServiceUrl[] | undefined {
  if (services === undefined || services.length === 0) {
    return undefined;
  }

  const urls = services.flatMap((service) => {
    if (service.endpoint?.kind === EndpointKind.TLS_PASSTHROUGH) {
      return [];
    }
    const url = service.url || service.endpoint?.url || "";
    return url === "" ? [] : [{ name: service.name, port: service.port, url }];
  });

  return urls.length === 0 ? undefined : urls;
}

function toSdkServiceEndpoints(
  services: readonly ProtoServiceStatus[] | undefined,
): readonly HttpsEndpointStatus[] | undefined {
  if (services === undefined || services.length === 0) {
    return undefined;
  }

  const endpoints = services.flatMap((service) => {
    if (service.endpoint?.kind !== EndpointKind.HTTPS) {
      return [];
    }
    const requestTimeoutSeconds = service.endpoint.requestTimeoutSeconds;
    if (requestTimeoutSeconds <= 0) {
      return [];
    }
    return [
      {
        auth: toSdkEndpointAuth(service.endpoint.auth),
        kind: "https" as const,
        name: service.name,
        port: service.port,
        requestTimeoutSeconds,
        url: service.endpoint.url,
      },
    ];
  });

  return endpoints.length === 0 ? undefined : endpoints;
}

function toSdkServiceAddresses(
  services: readonly ProtoServiceStatus[] | undefined,
): readonly TlsPassthroughEndpointStatus[] | undefined {
  if (services === undefined || services.length === 0) {
    return undefined;
  }

  const addresses = services.flatMap((service) => {
    if (service.endpoint?.kind !== EndpointKind.TLS_PASSTHROUGH) {
      return [];
    }
    const address = service.endpoint.address;
    return address === ""
      ? []
      : [
          {
            address,
            kind: "tls_passthrough" as const,
            name: service.name,
            port: service.port,
          },
        ];
  });

  return addresses.length === 0 ? undefined : addresses;
}

function toSdkEndpointAuth(auth: EndpointAuth): SdkEndpointAuth {
  return auth === EndpointAuth.SHARE_TOKEN ? "share_token" : "open";
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

function protocolName(protocol: ServiceProtocol): SdkServiceProtocol | undefined {
  switch (protocol) {
    case ServiceProtocol.TCP:
      return "tcp";
    case ServiceProtocol.UDP:
      return "udp";
    case ServiceProtocol.SCTP:
      return "sctp";
    default:
      return undefined;
  }
}

function toSdkResourceSpec(resource: Resources | undefined): ResourceSpec | undefined {
  if (resource === undefined) {
    return undefined;
  }

  const gpu = resource.gpu === undefined ? undefined : toSdkGpuSpec(resource.gpu);
  const spec: ResourceSpec = {
    ...(resource.cpu === "" ? {} : { cpu: resource.cpu }),
    ...(resource.memory === "" ? {} : { memory: resource.memory }),
    ...(gpu === undefined ? {} : { gpu }),
  };

  return Object.keys(spec).length === 0 ? undefined : spec;
}

function toSdkGpuSpec(gpu: Gpu): GpuSpec | undefined {
  const count = Number(gpu.count);
  if (!Number.isSafeInteger(count) || count < 1) {
    return undefined;
  }
  switch (gpu.selector.oneofKind) {
    case "type":
      return gpu.selector.type === "" ? { count } : { count, type: gpu.selector.type };
    case "memoryGb": {
      const memoryGb = Number(gpu.selector.memoryGb);
      return Number.isSafeInteger(memoryGb) && memoryGb > 0 ? { count, memoryGb } : { count };
    }
    default:
      return { count };
  }
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
    case State.PREPARING:
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

const NETWORK_CONFIG_MASK_PATHS: Readonly<Record<NetworkConfigUpdateField, string>> = {
  denyEgress: "spec.deny_egress",
  denyIngress: "spec.deny_ingress",
  dnsEgress: "spec.dns_egress",
  egress: "spec.egress",
  ingress: "spec.ingress",
};

export function toProtoCreateNetworkConfigRequest(
  request: CreateNetworkConfigRequest,
): ProtoCreateNetworkConfigRequest {
  return ProtoCreateNetworkConfigRequest.create({
    networkConfig: ProtoNetworkConfig.create({
      networkConfigId: request.networkConfigId,
      spec: toProtoNetwork(request.network) ?? ProtoNetworkOptions.create(),
    }),
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
  });
}

export function toProtoUpdateNetworkConfigRequest(
  request: UpdateNetworkConfigRequest,
): ProtoUpdateNetworkConfigRequest {
  return ProtoUpdateNetworkConfigRequest.create({
    networkConfigId: request.networkConfigId,
    networkConfig: ProtoNetworkConfig.create({
      networkConfigId: request.networkConfigId,
      spec: toProtoNetwork(request.network) ?? ProtoNetworkOptions.create(),
      ...(request.etag === undefined ? {} : { etag: request.etag }),
    }),
    updateMask: {
      paths: [...new Set(request.updateMask)].map((field) => NETWORK_CONFIG_MASK_PATHS[field]),
    },
  });
}

export function toSdkNetworkConfig(config: ProtoNetworkConfig): NetworkConfigResult {
  const spec = config.spec ?? ProtoNetworkOptions.create();
  const status = config.status;
  const unsupportedFields: NetworkConfigUnsupportedField[] = [];
  const egress = toSdkConfigRules(spec.egress, toSdkConfigEgressRule);
  const ingress = toSdkConfigRules(spec.ingress, toSdkConfigIngressRule);
  if (egress === undefined) {
    unsupportedFields.push("egress");
  }
  if (ingress === undefined) {
    unsupportedFields.push("ingress");
  }
  const dnsEgress = toSdkDnsEgressMode(spec.dnsEgress);
  const createdAt = toDate(status?.createTime);
  const updatedAt = toDate(status?.updateTime);

  return {
    networkConfigId: config.networkConfigId,
    network: {
      ...(spec.denyEgress === undefined ? {} : { denyEgress: spec.denyEgress }),
      ...(spec.denyIngress === undefined ? {} : { denyIngress: spec.denyIngress }),
      ...(dnsEgress === undefined ? {} : { dnsEgress }),
      ...(egress === undefined || egress.length === 0 ? {} : { egress }),
      ...(ingress === undefined || ingress.length === 0 ? {} : { ingress }),
    },
    ...(config.etag === undefined || config.etag === "" ? {} : { etag: config.etag }),
    ...(status?.sandboxId === undefined || status.sandboxId === ""
      ? {}
      : { sandboxId: status.sandboxId }),
    platformManaged: status?.platformManaged === true,
    unsupportedFields: unsupportedFields.sort(),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

/** Every stored rule mapped, or undefined when any one cannot be shown. */
function toSdkConfigRules<P, R>(
  rules: readonly P[],
  toSdk: (rule: P) => R | undefined,
): R[] | undefined {
  const mapped: R[] = [];
  for (const rule of rules) {
    const sdkRule = toSdk(rule);
    if (sdkRule === undefined) {
      return undefined;
    }
    mapped.push(sdkRule);
  }
  return mapped;
}

/**
 * A stored egress rule as `EgressRule`, or undefined when it cannot be shown:
 * an unknown destination or tenant, a hostname except, or a hostname rule on
 * ports other than TCP 443. A hostname rule reads back without its ports.
 */
function toSdkConfigEgressRule(rule: ProtoEgressRule): EgressRule | undefined {
  const ports = withPorts(toSdkPortRanges(rule.ports));
  const destination = rule.destination;
  switch (destination.oneofKind) {
    case "httpsHostname":
      if (
        destination.httpsHostname === "" ||
        rule.httpsHostnameExcept.length > 0 ||
        !isHttpsOnlyPorts(ports.ports)
      ) {
        return undefined;
      }
      return { dnsName: destination.httpsHostname };
    case "cidr":
      return { cidr: toSdkCidrBlock(destination.cidr), ...ports };
    case "tenant": {
      const tenant = toSdkTenantScope(destination.tenant);
      return tenant === "unspecified" ? undefined : { tenant, ...ports };
    }
    case "any":
      return destination.any ? { any: true, ...ports } : undefined;
    case "selector": {
      const { namespaceLabels, podLabels } = destination.selector;
      if (Object.keys(podLabels).length === 0) {
        return undefined;
      }
      return {
        selector: {
          podLabels: { ...podLabels },
          ...(Object.keys(namespaceLabels).length === 0
            ? {}
            : { namespaceLabels: { ...namespaceLabels } }),
        },
        ...ports,
      };
    }
    default:
      return undefined;
  }
}

/** A stored ingress rule as `IngressRule`, or undefined for an unknown source or tenant. */
function toSdkConfigIngressRule(rule: ProtoIngressRule): IngressRule | undefined {
  const ports = withPorts(toSdkPortRanges(rule.ports));
  const source = rule.source;
  switch (source.oneofKind) {
    case "cidr":
      return { cidr: toSdkCidrBlock(source.cidr), ...ports };
    case "tenant": {
      const tenant = toSdkTenantScope(source.tenant);
      return tenant === "unspecified" ? undefined : { tenant, ...ports };
    }
    case "any":
      return source.any ? { any: true, ...ports } : undefined;
    default:
      return undefined;
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
