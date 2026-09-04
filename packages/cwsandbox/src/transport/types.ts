// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type {
  Command,
  ExecOptions,
  ShellOptions,
  StartCommandOptions,
} from "../public/commands.js";
import type { RequestOptions, Seconds } from "../public/common.js";
import type { DataPlaneMode } from "../public/data-plane.js";
import type { MountedFiles } from "../public/files.js";
import type { LogStreamMode, LogStreamOptions } from "../public/logs.js";
import type { NetworkOptions, Service } from "../public/network.js";
import type { ResourceOptions } from "../public/resources.js";
import type {
  EnvironmentVariables,
  FileSystemSnapshotOptions,
  FileSystemSnapshotResult,
  SandboxAnnotations,
  SandboxFileType,
  SandboxId,
  SandboxObjectStorageAccess,
  SandboxRunOptions,
  SandboxTag,
  ScratchVolumeOptions,
  StopOptions,
} from "../public/sandbox.js";
import type { Secrets } from "../public/secrets.js";

export interface ListFileSystemSnapshotsRequest extends RequestOptions {
  readonly pageToken?: string;
}

export interface ListFileSystemSnapshotsResult {
  readonly nextPageToken?: string;
  readonly snapshots: readonly FileSystemSnapshotResult[];
}

export interface StartSandboxRequest extends Omit<SandboxRunOptions, "waitUntilRunning"> {
  readonly command: Command;
}

export interface StartSandboxFromFileRequest extends RequestOptions {
  readonly contents: Uint8Array;
  readonly primaryService: string;
  readonly fileType?: SandboxFileType;
  readonly imageOverrides?: Readonly<Record<string, string>>;
  readonly defaultResources?: ResourceOptions;
  readonly annotations?: SandboxAnnotations;
  readonly maxLifetimeSeconds?: Seconds;
  readonly network?: NetworkOptions;
  readonly objectStorageAccess?: SandboxObjectStorageAccess;
  readonly runnerIds?: readonly string[];
  readonly tags?: readonly SandboxTag[];
}

export interface StartSandboxFromTemplateRequest extends RequestOptions {
  readonly templateId: string;
  readonly annotations?: SandboxAnnotations;
  readonly containerImage?: string;
  readonly command?: Command;
  readonly environmentVariables?: EnvironmentVariables;
  readonly fileSystemSnapshot?: FileSystemSnapshotOptions;
  readonly mountedFiles?: MountedFiles;
  readonly maxLifetimeSeconds?: Seconds;
  readonly network?: NetworkOptions;
  readonly resources?: ResourceOptions;
  readonly runnerIds?: readonly string[];
  readonly services?: readonly Service[];
  readonly secrets?: Secrets;
  readonly tags?: readonly SandboxTag[];
  readonly volumes?: readonly ScratchVolumeOptions[];
}

export interface GetSandboxRequest extends RequestOptions {
  readonly sandboxId: SandboxId;
}

export interface ExecRequest extends Omit<ExecOptions, "check"> {
  readonly command: Command;
  readonly dataPlaneMode?: DataPlaneMode;
  readonly sandboxId: SandboxId;
}

export interface StartCommandRequest extends StartCommandOptions {
  readonly command: Command;
  readonly dataPlaneMode?: DataPlaneMode;
  readonly sandboxId: SandboxId;
}

export interface StartShellRequest extends Omit<ShellOptions, "command"> {
  readonly command: Command;
  readonly dataPlaneMode?: DataPlaneMode;
  readonly sandboxId: SandboxId;
}

export interface StreamLogsRequest extends LogStreamOptions {
  readonly dataPlaneMode?: DataPlaneMode;
  readonly mode: LogStreamMode;
  readonly sandboxId: SandboxId;
}

export interface StopSandboxRequest extends Omit<StopOptions, "missingOk"> {
  readonly allowMissing?: boolean;
  readonly sandboxId: SandboxId;
}

export interface DeleteSandboxRequest extends RequestOptions {
  readonly allowMissing?: boolean;
  readonly sandboxId: SandboxId;
}

export interface CreateFileSystemSnapshotRequest extends RequestOptions {
  readonly requestId: string;
  readonly sandboxId: SandboxId;
  /** Omitted when the sandbox has 0 or 1 scratch; required by Gateway when it has more. */
  readonly scratchVolumeName?: string;
}

export interface GetFileSystemSnapshotRequest extends RequestOptions {
  readonly snapshotId: string;
}

export interface DeleteFileSystemSnapshotRequest extends RequestOptions {
  readonly allowMissing?: boolean;
  readonly snapshotId: string;
}
