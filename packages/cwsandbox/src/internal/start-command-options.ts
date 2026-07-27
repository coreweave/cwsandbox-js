// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type {
  CommandProcess,
  CommandProcessWithStdin,
  StartCommandOptions,
} from "../public/commands.js";

/**
 * Start options for runtime/transport file plumbing only.
 *
 * Not part of public `SandboxCommands.start` / `StartCommandOptions`. Prefer
 * `files.readStream` / `files.writeStream` (or buffered `files.read` /
 * `files.write`) for binary transfers.
 *
 * - `binaryOutput`: skip UTF-8 decode into the text `stdout` stream; leave
 *   `wait().stdout` as `""`. Buffered file fallback accumulates bytes for
 *   `wait().stdoutBytes` without enqueueing `stdoutBinary`.
 * - `streamStdoutOnly`: with `binaryOutput`, skip wait-buffer accumulation and
 *   push frames to the bounded `stdoutBinary` queue (readStream consumer).
 */
export type InternalStartCommandOptions = StartCommandOptions & {
  readonly binaryOutput?: boolean;
  readonly streamStdoutOnly?: boolean;
};

/**
 * Process shape returned by `SandboxTransport.startCommand`.
 * `stdoutBinary` is for internal file StreamExec / readStream; it is not on
 * the public `CommandProcess` type from `commands.start`.
 */
export type InternalCommandProcess = CommandProcess & {
  readonly stdoutBinary: AsyncIterable<Uint8Array>;
};

export type InternalCommandProcessWithStdin = InternalCommandProcess & CommandProcessWithStdin;
