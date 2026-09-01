// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { normalizeCommand } from "../internal/commands.js";
import { validateShellOptions } from "../internal/validation/index.js";
import type { Command, ShellOptions, TerminalSession } from "../public/commands.js";
import type { SandboxRuntime } from "./context.js";

const DEFAULT_SHELL_COMMAND: Command = ["/bin/bash"];

export async function startShell(
  runtime: SandboxRuntime,
  options: ShellOptions = {},
): Promise<TerminalSession> {
  validateShellOptions(options);

  return runtime.transport.startShell({
    ...(options.cols === undefined ? {} : { cols: options.cols }),
    command:
      options.command === undefined ? DEFAULT_SHELL_COMMAND : normalizeCommand(options.command),
    ...(options.rows === undefined ? {} : { rows: options.rows }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    dataPlaneMode: runtime.dataPlaneMode,
    sandboxId: runtime.sandboxId,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
