// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type {
  CommandInput,
  ExecOptions,
  ProcessResult,
  SandboxCommands,
  ShellOptions,
  TerminalSession,
} from "./commands.js";
import type { RequestOptions, Seconds } from "./common.js";
import type { DataPlaneOptions } from "./data-plane.js";
import type { MountedFiles, SandboxFiles } from "./files.js";
import type { SandboxLogs } from "./logs.js";
import type {
  NetworkOptions,
  Service,
  ServiceProtocol,
  ServiceUrl,
  TlsPassthroughEndpointStatus,
} from "./network.js";
import type { ResourceOptions, ResourceSpec } from "./resources.js";
import type { Secrets } from "./secrets.js";

export type EnvironmentVariables = Readonly<Record<string, string>>;
export interface FromIdOptions extends RequestOptions, DataPlaneOptions {}
export type SandboxAnnotations = Readonly<Record<string, string>>;
export type SandboxId = string;
export type SandboxTag = string;

export type SandboxStatus =
  | "pending"
  | "creating"
  | "running"
  | "paused"
  | "terminating"
  | "completed"
  | "failed"
  | "terminated"
  | "unspecified";

export type WaitTargetStatus = "completed" | "paused" | "running" | "terminal";

export interface WaitOptions extends RequestOptions {
  readonly targetStatus?: WaitTargetStatus;
}

export type ObjectStoragePermission = "read" | "read-write";

/**
 * Temporary object-storage credentials for the sandbox (OSA / CAIOS).
 * Independent of file-system snapshots.
 */
export interface SandboxObjectStorageAccess {
  readonly buckets: readonly string[];
  readonly permission: ObjectStoragePermission;
  /**
   * Optional prefix that scopes the minted credential. Must satisfy Gateway
   * OSA prefix rules when set (alphanumeric start, trailing `/`, no `..`).
   */
  readonly objectPrefix?: string;
}

/**
 * Named scratch volume for snapshot/restore. Prefer `volumes` when the sandbox
 * needs a non-`workspace` name or more than one mount.
 *
 * Snapshots archive these mounts, not the whole container. `snapshot()` cannot
 * choose among multiple scratches created in this process.
 */
export interface ScratchVolumeOptions {
  /** Unique name within the sandbox (Gateway: 1-63 `[A-Za-z0-9_-]`). */
  readonly name: string;
  /**
   * Absolute directory to mount (not `/`). Must satisfy Gateway mount-path
   * rules (canonical, ≤256 chars, not a reserved system prefix).
   */
  readonly mountPath: string;
  /** Kubernetes resource quantity (e.g. `"10Gi"`). Omit for the platform default. */
  readonly size?: string;
  /** Restore this snapshot at start. Omit or empty for an empty volume. */
  readonly restoreFromSnapshotId?: string;
}

/**
 * Convenience single-mount scratch volume for snapshot/restore.
 *
 * Maps to a scratch volume named `workspace` mounted at `mountPath` on the
 * primary container. Snapshots archive that mount, not the whole container.
 * Mutually exclusive with `volumes`.
 */
export interface FileSystemSnapshotOptions {
  /**
   * Absolute directory to mount (not `/`). Must satisfy Gateway mount-path
   * rules (canonical, ≤256 chars, not a reserved system prefix).
   */
  readonly mountPath: string;
  /** Kubernetes resource quantity (e.g. `"10Gi"`). Omit for the platform default. */
  readonly size?: string;
  /** Restore this snapshot at start. Omit or empty for an empty volume. */
  readonly restoreFromSnapshotId?: string;
}

export type FileSystemSnapshotState = "creating" | "ready" | "failed" | "deleting" | "unspecified";

export type FileSystemSnapshotTrigger = "unspecified" | "manual" | "on_delete";

/** Org-scoped file-system snapshot record from Get/List, and from `snapshot()` once READY. */
export interface FileSystemSnapshotResult {
  readonly snapshotId: string;
  readonly state: FileSystemSnapshotState;
  readonly trigger: FileSystemSnapshotTrigger;
  /** Archive size when Get reports a safe integer; omitted otherwise. */
  readonly sizeBytes?: number;
  readonly stateReason?: string;
  readonly objectBucket?: string;
  readonly sourceSandboxId?: string;
  readonly sourceVolumeName?: string;
  readonly requestId?: string;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  readonly completedAt?: Date;
}

export interface ListSnapshotsOptions extends RequestOptions {
  /** Client-side filter after a full collect. Not sent on the List RPC. */
  readonly sourceSandboxId?: string;
  /** Client-side filter after a full collect (Python `status`). */
  readonly state?: FileSystemSnapshotState;
}

export interface DeleteSnapshotOptions extends RequestOptions {
  /**
   * When true, treat a missing snapshot (gRPC `NOT_FOUND` or trusted
   * `CWSANDBOX_FSS_NOT_FOUND`) as success. Defaults to `false`.
   */
  readonly missingOk?: boolean;
}

export interface SandboxRunOptions extends RequestOptions, DataPlaneOptions {
  readonly annotations?: SandboxAnnotations;
  readonly containerImage?: string;
  readonly environmentVariables?: EnvironmentVariables;
  readonly fileSystemSnapshot?: FileSystemSnapshotOptions;
  /**
   * Named scratch volumes. Mutually exclusive with `fileSystemSnapshot`.
   * Must be non-empty. `snapshot()` fails client-side when this process
   * created more than one scratch.
   */
  readonly volumes?: readonly ScratchVolumeOptions[];
  readonly maxLifetimeSeconds?: Seconds;
  readonly mountedFiles?: MountedFiles;
  readonly network?: NetworkOptions;
  readonly objectStorageAccess?: SandboxObjectStorageAccess;
  readonly resources?: ResourceOptions;
  readonly runnerIds?: readonly string[];
  readonly services?: readonly Service[];
  /**
   * Secret-store references to resolve server-side and inject as environment variables.
   *
   * Do not put secret values in `environmentVariables`, annotations, or tags.
   */
  readonly secrets?: Secrets;
  readonly tags?: readonly SandboxTag[];
  /**
   * Wait for the sandbox to reach `running` before resolving creation helpers.
   *
   * Defaults to `true`. Set to `false` only when you need a handle as soon as
   * the backend accepts the start request.
   */
  readonly waitUntilRunning?: boolean;
}

/**
 * Overlays for `runFromTemplate`. Omitted options preserve template values
 * unless `containerImage` is supplied.
 *
 * Replacement is per field, not a merge. Empty top-level maps/lists mean
 * inherit, not clear, except `network: {}`, which replaces the template
 * network. See each property.
 */
export interface SandboxRunFromTemplateOptions extends RequestOptions, DataPlaneOptions {
  /**
   * Non-empty input replaces the complete template map; it does not merge
   * keys. Empty `{}` means inherit, not clear.
   */
  readonly annotations?: SandboxAnnotations;
  /**
   * Replaces the complete template container list with one `main` container.
   * All omitted container settings are cleared, including
   * `imagePullCredentials`. A template using private-image credentials works
   * only while its container is inherited unchanged. Replacement credentials
   * are not supported.
   */
  readonly containerImage?: string;
  /**
   * Requires `containerImage`. When replacing the container, omitted values
   * are not inherited from the template.
   */
  readonly command?: CommandInput;
  /**
   * A non-empty map becomes the replacement environment. Omitted or empty
   * produces an empty replacement environment when `containerImage` is set.
   * Empty `{}` without `containerImage` means inherit.
   */
  readonly environmentVariables?: EnvironmentVariables;
  /**
   * Requires `containerImage`. When replacing the container, supplying this
   * replaces spec volumes and the replacement container's mounts. Omitting it
   * keeps template volumes and drops mounts on the new container. Inherited
   * registered volumes that lose their mounts are rejected by Gateway;
   * inherited scratch volumes can remain unmounted.
   */
  readonly fileSystemSnapshot?: FileSystemSnapshotOptions;
  /**
   * Requires `containerImage`. When replacing the container, supplying this
   * replaces spec volumes and the replacement container's mounts. Omitting it
   * keeps template volumes and drops mounts on the new container. Inherited
   * registered volumes that lose their mounts are rejected by Gateway;
   * inherited scratch volumes can remain unmounted. `volumes: []` is rejected.
   */
  readonly volumes?: readonly ScratchVolumeOptions[];
  /**
   * Non-zero replaces the template scalar. `0` means inherit, not clear.
   */
  readonly maxLifetimeSeconds?: Seconds;
  /**
   * Requires `containerImage`. When replacing the container, omitted values
   * are not inherited from the template.
   */
  readonly mountedFiles?: MountedFiles;
  /**
   * Any defined `network`, including `{}`, replaces the complete template
   * network. Omitted members are not inherited.
   */
  readonly network?: NetworkOptions;
  /**
   * Requires `containerImage`. When replacing the container, omitted values
   * are not inherited from the template. CPU and memory only; GPU is not
   * supported on `ResourceOptions`.
   */
  readonly resources?: ResourceOptions;
  /**
   * Non-empty input replaces the complete list. Empty `[]` means inherit,
   * not clear. Co-emits CKS mode on the wire. There is no `placementMode`
   * option; CKS placement is only via non-empty `runnerIds`.
   */
  readonly runnerIds?: readonly string[];
  /**
   * Non-empty input replaces the complete list. Empty `[]` means inherit,
   * not clear.
   */
  readonly services?: readonly Service[];
  /**
   * Requires `containerImage`. When replacing the container, omitted values
   * are not inherited from the template. `secrets: []` still requires
   * `containerImage`.
   */
  readonly secrets?: Secrets;
  /**
   * Non-empty input replaces the complete list. Empty `[]` means inherit,
   * not clear.
   */
  readonly tags?: readonly SandboxTag[];
  /**
   * Wait for the sandbox to reach `running` before resolving creation helpers.
   *
   * Defaults to `true`. Set to `false` only when you need a handle as soon as
   * the backend accepts the start request.
   */
  readonly waitUntilRunning?: boolean;
}

export interface StopOptions extends RequestOptions {
  /**
   * Seconds to wait for a graceful shutdown. Defaults to 10. Pass `0` to kill
   * immediately. Standalone `delete()` does not use this default.
   */
  readonly gracefulShutdownSeconds?: Seconds;
  /**
   * When true, treat a missing sandbox (gRPC `NOT_FOUND` or trusted
   * `CWSANDBOX_SANDBOX_NOT_FOUND`) as success. Defaults to `false`.
   */
  readonly missingOk?: boolean;
}

export interface DeleteOptions extends RequestOptions {
  /**
   * When true, treat a missing sandbox (gRPC `NOT_FOUND` or trusted
   * `CWSANDBOX_SANDBOX_NOT_FOUND`) as success. Defaults to `false`.
   */
  readonly missingOk?: boolean;
}

export interface ListSandboxesOptions extends RequestOptions {
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly runnerIds?: readonly string[];
  /**
   * When true, include terminal sandboxes (completed, failed, terminated).
   * Listing defaults to active-only.
   */
  readonly showTerminated?: boolean;
  readonly status?: SandboxStatus;
  readonly tags?: readonly SandboxTag[];
}

/**
 * Options for `SandboxClient.listSandboxes()` and `SandboxClient.listAll()`.
 *
 * Omits `pageToken` because the helper owns pagination. `timeoutMs` is a
 * wall-clock budget across all pages (default 300s), not a per-page RPC timeout.
 */
export type SandboxListOptions = Omit<ListSandboxesOptions, "pageToken"> & DataPlaneOptions;

export interface SandboxExposedPort {
  readonly name?: string;
  readonly port: number;
  readonly protocol?: ServiceProtocol;
}

export type SandboxResourceSpec = ResourceSpec;

export interface SandboxMetadata {
  readonly dnsEgressNames?: readonly string[];
  readonly exitCode?: number;
  readonly exposedPorts?: readonly SandboxExposedPort[];
  readonly resourceLimits?: SandboxResourceSpec;
  readonly resourceRequests?: SandboxResourceSpec;
  readonly runnerGroupId?: string;
  readonly runnerId?: string;
  readonly sandboxId: SandboxId;
  readonly serviceAddresses?: readonly TlsPassthroughEndpointStatus[];
  readonly serviceUrls?: readonly ServiceUrl[];
  readonly startedAt?: Date;
  readonly status?: SandboxStatus;
  readonly statusReason?: string;
}

export interface SandboxInfo extends SandboxMetadata {
  readonly status: SandboxStatus;
}

export interface ListSandboxesResult {
  readonly nextPageToken?: string;
  readonly sandboxes: readonly SandboxInfo[];
}

export interface StartSandboxResult extends SandboxMetadata {}

export interface GetSandboxResult extends SandboxMetadata {
  readonly status: SandboxStatus;
}

/** Public instance interface returned by client factories. */
export interface Sandbox {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;
  readonly logs: SandboxLogs;
  readonly sandboxId: SandboxId;
  readonly dnsEgressNames: readonly string[] | undefined;
  readonly exitCode: number | undefined;
  readonly exposedPorts: readonly SandboxExposedPort[] | undefined;
  readonly resourceLimits: SandboxResourceSpec | undefined;
  readonly resourceRequests: SandboxResourceSpec | undefined;
  readonly runnerGroupId: string | undefined;
  readonly runnerId: string | undefined;
  readonly serviceAddresses: readonly TlsPassthroughEndpointStatus[] | undefined;
  readonly serviceUrls: readonly ServiceUrl[] | undefined;
  readonly startedAt: Date | undefined;
  readonly status: SandboxStatus | undefined;
  readonly statusReason: string | undefined;
  exec(command: CommandInput, options?: ExecOptions): Promise<ProcessResult>;
  inspect(options?: RequestOptions): Promise<GetSandboxResult>;
  getStatus(options?: RequestOptions): Promise<SandboxStatus>;
  shell(options?: ShellOptions): Promise<TerminalSession>;
  wait(options?: WaitOptions): Promise<Sandbox>;
  /**
   * Snapshot the sandbox's scratch volume and wait until READY or FAILED.
   *
   * Returns the READY Get record (not only the ID). Default `timeoutMs` is 600s
   * (plus 5s internal observation slack). Snapshots outlive sandbox stop/delete;
   * call `client.deleteSnapshot` to remove them. Inspect without waiting with
   * `client.getSnapshot` / `client.listSnapshots`.
   *
   * One inherited scratch (for example after `runFromTemplate` with no volume
   * overlay) can infer the volume. Multiple inherited scratches are a backend
   * error.
   */
  snapshot(options?: RequestOptions): Promise<FileSystemSnapshotResult>;
  stop(options?: StopOptions): Promise<void>;
  delete(options?: DeleteOptions): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
