// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxExecutionError } from "../errors.js";
import { normalizeCommand } from "../internal/commands.js";
import type {
  InternalCommandProcess,
  InternalCommandProcessWithStdin,
  InternalStartCommandOptions,
} from "../internal/start-command-options.js";
import { validateExecOptions, validateStartCommandOptions } from "../internal/validation/index.js";
import type {
  CommandInput,
  ExecOptions,
  ProcessResult,
  SandboxCommands,
  StartCommandOptions,
  StartCommandOptionsWithStdin,
} from "../public/commands.js";
import type { SandboxRuntime } from "./context.js";

export function createSandboxCommands(runtime: SandboxRuntime): SandboxCommands {
  // Narrow to public SandboxCommands.start (no binary flags / stdoutBinary).
  const start = ((command: CommandInput, options?: StartCommandOptions) =>
    startCommand(runtime, command, options)) as unknown as SandboxCommands["start"];
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
): Promise<InternalCommandProcessWithStdin>;
export function startCommand(
  runtime: SandboxRuntime,
  command: CommandInput,
  options?: InternalStartCommandOptions,
): Promise<InternalCommandProcess>;
export async function startCommand(
  runtime: SandboxRuntime,
  command: CommandInput,
  options: InternalStartCommandOptions = {},
): Promise<InternalCommandProcess | InternalCommandProcessWithStdin> {
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
