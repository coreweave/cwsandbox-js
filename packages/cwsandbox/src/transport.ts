// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { InternalCommandProcess } from "./internal/start-command-options.js";
import type { ProcessResult, TerminalSession } from "./public/commands.js";
import type { LogEntryStream, LogRawStream, LogStream } from "./public/logs.js";
import type {
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  StartSandboxResult,
} from "./public/sandbox.js";
import type {
  DeleteSandboxRequest,
  ExecRequest,
  GetSandboxRequest,
  ReadFileRequest,
  ReadFileResult,
  StartSandboxRequest,
  StartCommandRequest,
  StartShellRequest,
  StreamLogsRequest,
  StopSandboxRequest,
  WriteFileRequest,
} from "./transport/types.js";

export interface SandboxTransport {
  start(request: StartSandboxRequest): Promise<StartSandboxResult>;
  get(request: GetSandboxRequest): Promise<GetSandboxResult>;
  list(options: ListSandboxesOptions): Promise<ListSandboxesResult>;
  delete(request: DeleteSandboxRequest): Promise<void>;
  exec(request: ExecRequest): Promise<ProcessResult>;
  /** Returns an internal process that may expose `stdoutBinary` for file I/O. */
  startCommand(request: StartCommandRequest): Promise<InternalCommandProcess>;
  startShell(request: StartShellRequest): Promise<TerminalSession>;
  streamLogs(request: StreamLogsRequest): Promise<LogEntryStream | LogRawStream | LogStream>;
  stop(request: StopSandboxRequest): Promise<void>;
  writeFile(request: WriteFileRequest): Promise<void>;
  readFile(request: ReadFileRequest): Promise<ReadFileResult>;
}
