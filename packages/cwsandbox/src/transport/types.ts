// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type {
  Command,
  ExecOptions,
  ShellOptions,
  StartCommandOptions,
} from "../public/commands.js";
import type { RequestOptions } from "../public/common.js";
import type { LogStreamMode, LogStreamOptions } from "../public/logs.js";
import type {
  FileSystemSnapshotResult,
  SandboxId,
  SandboxRunOptions,
  StopOptions,
} from "../public/sandbox.js";

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

export interface GetSandboxRequest extends RequestOptions {
  readonly sandboxId: SandboxId;
}

export interface ExecRequest extends Omit<ExecOptions, "check"> {
  readonly command: Command;
  readonly sandboxId: SandboxId;
}

export interface StartCommandRequest extends StartCommandOptions {
  readonly command: Command;
  readonly sandboxId: SandboxId;
}

export interface StartShellRequest extends Omit<ShellOptions, "command"> {
  readonly command: Command;
  readonly sandboxId: SandboxId;
}

export interface StreamLogsRequest extends LogStreamOptions {
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
}

export interface GetFileSystemSnapshotRequest extends RequestOptions {
  readonly snapshotId: string;
}

export interface DeleteFileSystemSnapshotRequest extends RequestOptions {
  readonly allowMissing?: boolean;
  readonly snapshotId: string;
}
