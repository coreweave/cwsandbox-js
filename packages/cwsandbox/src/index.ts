// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export { SandboxClient, type SandboxClientOptions, type WithSandboxCallback } from "./client.js";
export { DEFAULT_KEEP_ALIVE_COMMAND, DEFAULT_LIST_ALL_TIMEOUT_MS } from "./defaults.js";
export {
  CWSandboxAuthenticationError,
  type CWSandboxErrorCode,
  CWSandboxConfigurationError,
  CWSandboxError,
  CWSandboxExecutionError,
  CWSandboxFileError,
  isCWSandboxError,
  CWSandboxNotFoundError,
  CWSandboxNotImplementedError,
  CWSandboxResourceExhaustedError,
  CWSandboxTerminalStateUnavailableError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  type CWSandboxTransportErrorOptions,
  type CWSandboxTransportKind,
  CWSandboxUnavailableError,
  CWSandboxValidationError,
} from "./errors.js";
export {
  CWSANDBOX_BACKEND_UNAVAILABLE,
  CWSANDBOX_COMMAND_TIMEOUT,
  CWSANDBOX_ERROR_DOMAIN,
  CWSANDBOX_FILE_IO_FAILED,
  CWSANDBOX_FILE_IS_DIRECTORY,
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_PERMISSION_DENIED,
  CWSANDBOX_FILE_TOO_LARGE,
  CWSANDBOX_FILE_TRUNCATED,
  CWSANDBOX_RUNNER_UNAVAILABLE,
  CWSANDBOX_SANDBOX_NOT_FOUND,
} from "./internal/error-info.js";
export { Sandbox } from "./sandbox.js";
export { SandboxList } from "./runtime/sandbox-list.js";
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
  DeleteOptions,
  EnvironmentVariables,
  FromIdOptions,
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  SandboxAnnotations,
  SandboxExposedPort,
  SandboxId,
  SandboxInfo,
  SandboxListOptions,
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
export type { SecretInput, Secrets } from "./public/secrets.js";
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
