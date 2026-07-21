// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../errors.js";
import type { Command, CommandInput } from "../public/commands.js";

export function commandForWorkingDirectory(command: Command, cwd: string | undefined): string[] {
  if (cwd === undefined) {
    return [...command];
  }

  return ["/bin/sh", "-lc", `cd ${shellQuote(cwd)} && exec ${command.map(shellQuote).join(" ")}`];
}

export function normalizeCommand(command: CommandInput): Command {
  const [executable, ...args] = command;

  if (executable === undefined) {
    throw new CWSandboxValidationError("Command must contain at least one item.");
  }

  if (executable.trim() === "") {
    throw new CWSandboxValidationError("Command executable must not be blank.");
  }

  return [executable, ...args];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
