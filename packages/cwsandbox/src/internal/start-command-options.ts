// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type {
  CommandProcess,
  CommandProcessWithStdin,
  StartCommandOptions,
} from "../public/commands.js";

/**
 * Runtime/transport start options. Not part of the public `commands.start` API;
 * used by file StreamExec / readStream / writeStream.
 */
export type InternalStartCommandOptions = StartCommandOptions & {
  readonly binaryOutput?: boolean;
  readonly streamStdoutOnly?: boolean;
};

/** Process returned by transport `startCommand` for file binary stdout. */
export type InternalCommandProcess = CommandProcess & {
  readonly stdoutBinary: AsyncIterable<Uint8Array>;
};

export type InternalCommandProcessWithStdin = InternalCommandProcess & CommandProcessWithStdin;
