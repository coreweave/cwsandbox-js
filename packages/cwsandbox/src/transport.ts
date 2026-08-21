// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type {
  CommandProcess,
  CommandProcessWithStdin,
  ProcessResult,
  TerminalSession,
} from "./public/commands.js";
import type { LogEntryStream, LogRawStream, LogStream } from "./public/logs.js";
import type {
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  StartSandboxResult,
} from "./public/sandbox.js";
import type {
  CreateFileSystemSnapshotRequest,
  DeleteFileSystemSnapshotRequest,
  DeleteSandboxRequest,
  ExecRequest,
  FileSystemSnapshotRecord,
  GetFileSystemSnapshotRequest,
  GetSandboxRequest,
  ListFileSystemSnapshotsRequest,
  ListFileSystemSnapshotsResult,
  StartSandboxRequest,
  StartCommandRequest,
  StartShellRequest,
  StreamLogsRequest,
  StopSandboxRequest,
} from "./transport/types.js";

export interface SandboxTransport {
  start(request: StartSandboxRequest): Promise<StartSandboxResult>;
  get(request: GetSandboxRequest): Promise<GetSandboxResult>;
  list(options: ListSandboxesOptions): Promise<ListSandboxesResult>;
  delete(request: DeleteSandboxRequest): Promise<void>;
  createFileSystemSnapshot(
    request: CreateFileSystemSnapshotRequest,
  ): Promise<FileSystemSnapshotRecord>;
  getFileSystemSnapshot(request: GetFileSystemSnapshotRequest): Promise<FileSystemSnapshotRecord>;
  listFileSystemSnapshots(
    request: ListFileSystemSnapshotsRequest,
  ): Promise<ListFileSystemSnapshotsResult>;
  deleteFileSystemSnapshot(request: DeleteFileSystemSnapshotRequest): Promise<void>;
  exec(request: ExecRequest): Promise<ProcessResult>;
  startCommand(request: StartCommandRequest & { readonly stdin?: false }): Promise<CommandProcess>;
  startCommand(
    request: StartCommandRequest & { readonly stdin: true },
  ): Promise<CommandProcessWithStdin>;
  startCommand(request: StartCommandRequest): Promise<CommandProcess | CommandProcessWithStdin>;
  startShell(request: StartShellRequest): Promise<TerminalSession>;
  streamLogs(request: StreamLogsRequest): Promise<LogEntryStream | LogRawStream | LogStream>;
  stop(request: StopSandboxRequest): Promise<void>;
}
