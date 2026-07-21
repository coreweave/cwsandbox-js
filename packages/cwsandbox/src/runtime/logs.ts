// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { validateLogReadOptions, validateLogStreamOptions } from "../internal/validation/index.js";
import type {
  LogEntryStream,
  LogRawStream,
  LogReadOptions,
  LogStream,
  LogStreamOptions,
  SandboxLogs,
} from "../public/logs.js";
import type { SandboxRuntime } from "./context.js";

export function createSandboxLogs(runtime: SandboxRuntime): SandboxLogs {
  return {
    read: (options) => readLogs(runtime, options),
    stream: (options) => streamLogs(runtime, options),
    streamEntries: (options) => streamLogEntries(runtime, options),
    streamRaw: (options) => streamRawLogs(runtime, options),
  };
}

async function readLogs(runtime: SandboxRuntime, options: LogReadOptions = {}): Promise<string[]> {
  validateLogReadOptions(options);

  const stream = await streamLogs(runtime, options);
  const lines: string[] = [];

  try {
    for await (const line of stream) {
      lines.push(line);
    }
  } finally {
    await stream.cancel().catch(() => undefined);
  }

  return lines;
}

async function streamLogs(
  runtime: SandboxRuntime,
  options: LogStreamOptions = {},
): Promise<LogStream> {
  validateLogStreamOptions(options);

  return (await runtime.transport.streamLogs({
    ...options,
    mode: "lines",
    sandboxId: runtime.sandboxId,
  })) as LogStream;
}

async function streamLogEntries(
  runtime: SandboxRuntime,
  options: LogStreamOptions = {},
): Promise<LogEntryStream> {
  validateLogStreamOptions(options);

  return (await runtime.transport.streamLogs({
    ...options,
    mode: "entries",
    sandboxId: runtime.sandboxId,
  })) as LogEntryStream;
}

async function streamRawLogs(
  runtime: SandboxRuntime,
  options: LogStreamOptions = {},
): Promise<LogRawStream> {
  validateLogStreamOptions(options);

  return (await runtime.transport.streamLogs({
    ...options,
    mode: "raw",
    sandboxId: runtime.sandboxId,
  })) as LogRawStream;
}
