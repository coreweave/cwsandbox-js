// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { RequestOptions } from "./common.js";

export type Command = readonly [string, ...string[]];
export type CommandInputData = string | Uint8Array;
export type CommandInput = Command | ReadonlyArray<string>;
export type CommandOutputStream = AsyncIterable<string>;
export type CommandProcessStatus = "cancelled" | "exited" | "failed" | "running" | "starting";

export interface ExecOptions extends RequestOptions {
  readonly bufferedMaxKiB?: number;
  readonly check?: boolean;
  readonly cwd?: string;
}

export interface StartCommandOptions extends RequestOptions {
  /**
   * Accumulate stdout as bytes only (skip UTF-8 decode / stdout string).
   * Used by large-file StreamExec fallback; not part of the general public
   * command API surface.
   */
  readonly binaryOutput?: boolean;
  readonly bufferedMaxKiB?: number;
  readonly check?: boolean;
  readonly cwd?: string;
  readonly stdin?: boolean;
}

export interface StartCommandOptionsWithStdin extends StartCommandOptions {
  readonly stdin: true;
}

export interface ShellOptions extends RequestOptions {
  readonly cols?: number;
  readonly command?: CommandInput;
  readonly rows?: number;
}

export interface ProcessResult {
  readonly command: Command;
  readonly exitCode: number;
  readonly failed: boolean;
  readonly ok: boolean;
  readonly stderr: string;
  readonly stderrBytes: Uint8Array;
  readonly stderrBytesProduced: number;
  readonly stderrTruncated: boolean;
  readonly stdout: string;
  readonly stdoutBytes: Uint8Array;
  readonly stdoutBytesProduced: number;
  readonly stdoutTruncated: boolean;
}

export interface SandboxCommands {
  run(command: CommandInput, options?: ExecOptions): Promise<ProcessResult>;
  start(
    command: CommandInput,
    options: StartCommandOptionsWithStdin,
  ): Promise<CommandProcessWithStdin>;
  start(command: CommandInput, options?: StartCommandOptions): Promise<CommandProcess>;
}

export interface CommandProcess {
  readonly command: Command;
  readonly exitCode: number | undefined;
  readonly stderr: CommandOutputStream;
  readonly status: CommandProcessStatus;
  readonly stdout: CommandOutputStream;
  cancel(options?: RequestOptions): Promise<void>;
  poll(): number | undefined;
  wait(options?: RequestOptions): Promise<ProcessResult>;
}

export interface CommandProcessWithStdin extends CommandProcess {
  readonly stdin: CommandInputWriter;
}

export interface CommandInputWriter {
  readonly closed: boolean;
  close(options?: RequestOptions): Promise<void>;
  write(data: CommandInputData, options?: RequestOptions): Promise<void>;
  writeln(text: string, options?: RequestOptions): Promise<void>;
}

export interface TerminalResult {
  readonly command: Command;
  readonly exitCode: number;
}

export interface TerminalSession {
  readonly command: Command;
  readonly exitCode: number | undefined;
  readonly output: AsyncIterable<Uint8Array>;
  readonly stdin: CommandInputWriter;
  readonly status: CommandProcessStatus;
  cancel(options?: RequestOptions): Promise<void>;
  poll(): number | undefined;
  resize(cols: number, rows: number, options?: RequestOptions): Promise<void>;
  wait(options?: RequestOptions): Promise<TerminalResult>;
}
