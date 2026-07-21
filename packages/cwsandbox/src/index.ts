// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export { SandboxClient, type SandboxClientOptions, type WithSandboxCallback } from "./client.js";
export { DEFAULT_KEEP_ALIVE_COMMAND } from "./defaults.js";
export {
  CWSandboxAuthenticationError,
  type CWSandboxErrorCode,
  CWSandboxConfigurationError,
  CWSandboxError,
  CWSandboxExecutionError,
  isCWSandboxError,
  CWSandboxNotFoundError,
  CWSandboxNotImplementedError,
  CWSandboxResourceExhaustedError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  type CWSandboxTransportErrorOptions,
  type CWSandboxTransportKind,
  CWSandboxUnavailableError,
  CWSandboxValidationError,
} from "./errors.js";
export { Sandbox } from "./sandbox.js";
export type { SandboxTransport } from "./transport.js";
export type {
  Command,
  CommandInput,
  CommandInputData,
  CommandInputWriter,
  CommandOutputStream,
  CommandProcess,
  CommandProcessStatus,
  CommandProcessWithStdin,
  ExecOptions,
  ProcessResult,
  SandboxCommands,
  ShellOptions,
  StartCommandOptions,
  StartCommandOptionsWithStdin,
  TerminalResult,
  TerminalSession,
} from "./public/commands.js";
export type { Milliseconds, RequestOptions, Seconds } from "./public/common.js";
export type {
  FileContent,
  FileReadResult,
  FileTextReadResult,
  FileWrite,
  FileWrites,
  MountedFile,
  MountedFileContent,
  MountedFiles,
  SandboxFiles,
} from "./public/files.js";
export type {
  LogEntry,
  LogEntryStream,
  LogRawChunk,
  LogRawStream,
  LogReadOptions,
  LogResumeCursor,
  LogStream,
  LogStreamMode,
  LogStreamOptions,
  SandboxLogs,
} from "./public/logs.js";
export type { NetworkOptions, PortInput, PortOptions, PortProtocol } from "./public/network.js";
export type {
  ResourceOptions,
  ResourceRequestsAndLimits,
  ResourceSpec,
} from "./public/resources.js";
export type {
  EnvironmentVariables,
  FromIdOptions,
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  SandboxAnnotations,
  SandboxExposedPort,
  SandboxId,
  SandboxInfo,
  SandboxMetadata,
  SandboxResourceSpec,
  SandboxRunOptions,
  SandboxStatus,
  SandboxTag,
  StartSandboxResult,
  StopOptions,
  WaitOptions,
  WaitTargetStatus,
} from "./public/sandbox.js";
export type {
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
