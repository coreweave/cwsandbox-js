// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxExecutionError } from "../errors.js";
import { normalizeCommand } from "../internal/commands.js";
import type { InternalStartCommandOptions } from "../internal/start-command-options.js";
import { validateExecOptions, validateStartCommandOptions } from "../internal/validation/index.js";
import type {
  CommandInput,
  CommandProcess,
  CommandProcessWithStdin,
  ExecOptions,
  ProcessResult,
  SandboxCommands,
  StartCommandOptions,
  StartCommandOptionsWithStdin,
} from "../public/commands.js";
import type { SandboxRuntime } from "./context.js";

export function createSandboxCommands(runtime: SandboxRuntime): SandboxCommands {
  const start = ((command: CommandInput, options?: StartCommandOptions) =>
    startCommand(runtime, command, options)) as SandboxCommands["start"];
  return {
    run: (command, execOptions) => execCommand(runtime, command, execOptions),
    start,
  };
}

export async function execCommand(
  runtime: SandboxRuntime,
  command: CommandInput,
  options: ExecOptions = {},
): Promise<ProcessResult> {
  validateExecOptions(options);
  const { check, ...transportOptions } = options;
  const normalizedCommand = normalizeCommand(command);

  const result = await runtime.transport.exec({
    ...transportOptions,
    command: normalizedCommand,
    sandboxId: runtime.sandboxId,
  });

  throwIfCheckedFailed(result, check);
  return result;
}

export function startCommand(
  runtime: SandboxRuntime,
  command: CommandInput,
  options: StartCommandOptionsWithStdin & InternalStartCommandOptions,
): Promise<CommandProcessWithStdin>;
export function startCommand(
  runtime: SandboxRuntime,
  command: CommandInput,
  options?: InternalStartCommandOptions,
): Promise<CommandProcess>;
export async function startCommand(
  runtime: SandboxRuntime,
  command: CommandInput,
  options: InternalStartCommandOptions = {},
): Promise<CommandProcess | CommandProcessWithStdin> {
  validateStartCommandOptions(options);

  return runtime.transport.startCommand({
    ...options,
    command: normalizeCommand(command),
    sandboxId: runtime.sandboxId,
  });
}

export function throwIfCheckedFailed(result: ProcessResult, check: boolean | undefined): void {
  if (check === true && result.exitCode !== 0) {
    throw new CWSandboxExecutionError(result);
  }
}
