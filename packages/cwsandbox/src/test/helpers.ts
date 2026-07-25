// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { SandboxClient } from "../client.js";
import type {
  Command,
  CommandInputData,
  CommandInputWriter,
  CommandProcess,
  CommandProcessWithStdin,
  LogEntryStream,
  LogRawStream,
  LogStream,
  LogStreamMode,
  ProcessResult,
  SandboxStatus,
  SandboxTransport,
  TerminalSession,
} from "../index.js";

const textEncoder = new TextEncoder();

export function createProcessResult(
  command: Command,
  overrides: Partial<ProcessResult> = {},
): ProcessResult {
  const stdout = overrides.stdout ?? command.join(" ");
  const stderr = overrides.stderr ?? "";
  const stdoutBytes = overrides.stdoutBytes ?? textEncoder.encode(stdout);
  const stderrBytes = overrides.stderrBytes ?? textEncoder.encode(stderr);
  const exitCode = overrides.exitCode ?? 0;

  return {
    command,
    exitCode,
    failed: exitCode !== 0,
    ok: exitCode === 0,
    stderr,
    stderrBytes,
    stderrBytesProduced: stderrBytes.byteLength,
    stderrTruncated: false,
    stdout,
    stdoutBytes,
    stdoutBytesProduced: stdoutBytes.byteLength,
    stdoutTruncated: false,
    ...overrides,
  };
}

export function createCommandInputWriter(): CommandInputWriter {
  return {
    closed: false,
    async close() {
      return undefined;
    },
    async write(_data: CommandInputData) {
      return undefined;
    },
    async writeln(_text: string) {
      return undefined;
    },
  };
}

export function createCommandProcess(command: Command): CommandProcess;
export function createCommandProcess(command: Command, stdin: true): CommandProcessWithStdin;
export function createCommandProcess(
  command: Command,
  stdin = false,
): CommandProcess | CommandProcessWithStdin {
  const process = {
    cancel: async () => undefined,
    command,
    exitCode: 0,
    stderr: emptyStream(),
    status: "exited" as const,
    stdout: streamFrom([command.join(" ")]),
    stdoutBinary: emptyBinaryStream(),
    poll() {
      return 0;
    },
    async wait() {
      return createProcessResult(command);
    },
  };

  if (stdin) {
    return {
      ...process,
      stdin: createCommandInputWriter(),
    };
  }

  return process;
}

export function createLogStream(mode: "lines"): LogStream;
export function createLogStream(mode: "entries"): LogEntryStream;
export function createLogStream(mode: "raw"): LogRawStream;
export function createLogStream(mode: LogStreamMode): LogEntryStream | LogRawStream | LogStream;
export function createLogStream(mode: LogStreamMode): LogEntryStream | LogRawStream | LogStream {
  const base = {
    cancel: async () => undefined,
    close: async () => undefined,
    closed: true,
    offset: undefined,
    sessionId: undefined,
  };

  if (mode === "entries") {
    return {
      ...base,
      [Symbol.asyncIterator]: async function* () {},
    };
  }

  if (mode === "raw") {
    return {
      ...base,
      [Symbol.asyncIterator]: async function* () {},
    };
  }

  return {
    ...base,
    [Symbol.asyncIterator]: async function* () {},
  };
}

export function createTerminalSession(command: Command): TerminalSession {
  const result = {
    command,
    exitCode: 0,
  };

  return {
    cancel: async () => undefined,
    command,
    exitCode: 0,
    output: byteStreamFrom([new TextEncoder().encode(command.join(" "))]),
    poll() {
      return 0;
    },
    resize: async () => undefined,
    status: "exited",
    stdin: createCommandInputWriter(),
    async wait() {
      return result;
    },
  };
}

export function createFakeTransport(
  statuses: readonly SandboxStatus[] = ["running"],
): SandboxTransport {
  const statusQueue = [...statuses];
  let stopped = false;

  return {
    async start(request) {
      return {
        sandboxId: `sandbox-for-${request.command[0]}`,
        status: "running",
      };
    },
    async get(request) {
      if (stopped) {
        return {
          sandboxId: request.sandboxId,
          status: "terminated",
        };
      }

      return {
        sandboxId: request.sandboxId,
        status: statusQueue.shift() ?? statuses.at(-1) ?? "running",
      };
    },
    async list() {
      return {
        sandboxes: [
          {
            sandboxId: "sandbox-for-echo",
            status: stopped ? "terminated" : (statusQueue.at(0) ?? statuses.at(-1) ?? "running"),
          },
        ],
      };
    },
    async delete() {
      return undefined;
    },
    async exec(request) {
      return createProcessResult(request.command);
    },
    async startCommand(request) {
      return request.stdin === true
        ? createCommandProcess(request.command, true)
        : createCommandProcess(request.command);
    },
    async startShell(request) {
      return createTerminalSession(request.command);
    },
    async streamLogs(request) {
      return createLogStream(request.mode);
    },
    async stop() {
      stopped = true;
      return undefined;
    },
    async writeFile() {
      return undefined;
    },
    async readFile() {
      return {
        content: new Uint8Array(),
      };
    },
  };
}

async function* emptyStream(): AsyncIterable<string> {}

async function* emptyBinaryStream(): AsyncIterable<Uint8Array> {}

async function* byteStreamFrom(values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield value;
  }
}

async function* streamFrom(values: readonly string[]): AsyncIterable<string> {
  for (const value of values) {
    yield value;
  }
}

export function createTrackingTransport(): {
  readonly stoppedSandboxIds: string[];
  readonly transport: SandboxTransport;
} {
  const stoppedSandboxIds: string[] = [];
  const base = createFakeTransport();

  return {
    stoppedSandboxIds,
    transport: {
      ...base,
      async stop(request) {
        stoppedSandboxIds.push(request.sandboxId);
        await base.stop(request);
      },
    },
  };
}

export function createClient(transport: SandboxTransport = createFakeTransport()): SandboxClient {
  return new SandboxClient({
    transport,
  });
}
