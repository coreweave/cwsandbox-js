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
  GetSandboxResult,
  SandboxId,
  SandboxRunOptions,
  StartSandboxResult,
  StopOptions,
} from "../public/sandbox.js";

export interface StartSandboxRequest extends Omit<SandboxRunOptions, "waitUntilRunning"> {
  readonly command: Command;
}

export type { StartSandboxResult, GetSandboxResult };

export interface GetSandboxRequest extends RequestOptions {
  readonly sandboxId: SandboxId;
}

export interface ExecRequest extends Omit<ExecOptions, "check"> {
  readonly command: Command;
  readonly sandboxId: SandboxId;
}

export interface StartCommandRequest extends StartCommandOptions {
  /**
   * Internal file plumbing (not public `commands.start` options).
   * Skip UTF-8 decode into text stdout; see `InternalStartCommandOptions`.
   */
  readonly binaryOutput?: boolean;
  readonly command: Command;
  readonly sandboxId: SandboxId;
  /**
   * Internal file plumbing (not public `commands.start` options).
   * With `binaryOutput`, stream via `stdoutBinary` instead of wait-buffering.
   */
  readonly streamStdoutOnly?: boolean;
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
  readonly sandboxId: SandboxId;
}

export interface DeleteSandboxRequest extends RequestOptions {
  readonly sandboxId: SandboxId;
}

export interface WriteFileRequest extends RequestOptions {
  readonly content: Uint8Array;
  readonly path: string;
  readonly sandboxId: SandboxId;
}

export interface ReadFileRequest extends RequestOptions {
  readonly path: string;
  readonly sandboxId: SandboxId;
}

export interface ReadFileResult {
  readonly content: Uint8Array;
}
