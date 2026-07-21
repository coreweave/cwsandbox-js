// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { expectTypeOf } from "vitest";

import {
  CWSandboxExecutionError,
  DEFAULT_KEEP_ALIVE_COMMAND,
  type Command,
  type CommandInputData,
  type CommandInputWriter,
  type CommandProcess,
  type CommandOutputStream,
  type CommandInput,
  type CommandProcessWithStdin,
  type CommandProcessStatus,
  type FileReadResult,
  type FileTextReadResult,
  type FileWrite,
  type FileWrites,
  type GetSandboxResult,
  type LogEntry,
  type LogEntryStream,
  type LogRawChunk,
  type LogRawStream,
  type LogReadOptions,
  type LogResumeCursor,
  type LogStream,
  type LogStreamOptions,
  type ListSandboxesResult,
  type MountedFile,
  type MountedFileContent,
  type MountedFiles,
  type NetworkOptions,
  type PortInput,
  type PortOptions,
  type ProcessResult,
  type ResourceRequestsAndLimits,
  type SandboxAnnotations,
  type SandboxExposedPort,
  type SandboxInfo,
  type SandboxMetadata,
  type SandboxResourceSpec,
  type SandboxRunOptions,
  type SandboxStatus,
  type SandboxTag,
  SandboxClient,
  type StartSandboxResult,
  type StartCommandOptionsWithStdin,
  type TerminalResult,
  type TerminalSession,
  type WaitOptions,
  type WaitTargetStatus,
} from "./index.js";
import type { SandboxTransport } from "./transport.js";
import {
  createSandboxClient as createWandbSubpathClient,
  createSandboxClientFromEnv as createWandbSubpathClientFromEnv,
  type WandbSandboxClientOptions,
  type WandbSandboxEnvironment,
} from "./wandb/index.js";

const transport = {
  async exec(request) {
    return {
      command: request.command,
      exitCode: 0,
      failed: false,
      ok: true,
      stderr: "",
      stderrBytes: new Uint8Array(),
      stderrBytesProduced: 0,
      stderrTruncated: false,
      stdout: "",
      stdoutBytes: new Uint8Array(),
      stdoutBytesProduced: 0,
      stdoutTruncated: false,
    };
  },
  async get(request) {
    return {
      sandboxId: request.sandboxId,
      status: "running",
    };
  },
  async start(request) {
    return {
      sandboxId: request.command[0],
      status: "running",
    };
  },
  async startCommand(request) {
    const process = {
      cancel: async () => undefined,
      command: request.command,
      exitCode: 0,
      stderr: (async function* () {})(),
      status: "exited" as const,
      stdout: (async function* () {})(),
      poll() {
        return 0;
      },
      async wait() {
        return {
          command: request.command,
          exitCode: 0,
          failed: false,
          ok: true,
          stderr: "",
          stderrBytes: new Uint8Array(),
          stderrBytesProduced: 0,
          stderrTruncated: false,
          stdout: "",
          stdoutBytes: new Uint8Array(),
          stdoutBytesProduced: 0,
          stdoutTruncated: false,
        };
      },
    };

    if (request.stdin === true) {
      return {
        ...process,
        stdin: {
          closed: false,
          close: async () => undefined,
          write: async (_data: CommandInputData) => undefined,
          writeln: async (_text: string) => undefined,
        },
      };
    }

    return process;
  },
  async startShell(request) {
    return {
      cancel: async () => undefined,
      command: request.command,
      exitCode: 0,
      output: (async function* () {})(),
      poll() {
        return 0;
      },
      resize: async () => undefined,
      status: "exited" as const,
      stdin: {
        closed: false,
        close: async () => undefined,
        write: async (_data: CommandInputData) => undefined,
        writeln: async (_text: string) => undefined,
      },
      async wait() {
        return {
          command: request.command,
          exitCode: 0,
        };
      },
    };
  },
  async streamLogs(request) {
    const base = {
      cancel: async () => undefined,
      close: async () => undefined,
      closed: true,
      offset: undefined,
      sessionId: undefined,
    };

    if (request.mode === "entries") {
      return {
        ...base,
        [Symbol.asyncIterator]: async function* () {},
      };
    }

    if (request.mode === "raw") {
      return {
        ...base,
        [Symbol.asyncIterator]: async function* () {},
      };
    }

    return {
      ...base,
      [Symbol.asyncIterator]: async function* () {},
    };
  },
  async list() {
    return {
      sandboxes: [],
    };
  },
  async delete() {
    return undefined;
  },
  async stop() {
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
} satisfies SandboxTransport;

const wandbOptions: WandbSandboxClientOptions = {
  apiKey: "wandb-key",
  entity: "team",
  project: "project",
};
const wandbEnvironment: WandbSandboxEnvironment = {
  WANDB_API_KEY: "wandb-key",
  WANDB_ENTITY: "team",
  WANDB_PROJECT: "project",
};
expectTypeOf(createWandbSubpathClient(wandbOptions)).toEqualTypeOf<SandboxClient>();
expectTypeOf(createWandbSubpathClientFromEnv(wandbEnvironment)).toEqualTypeOf<SandboxClient>();
const client = new SandboxClient({ transport });

expectTypeOf(DEFAULT_KEEP_ALIVE_COMMAND).toExtend<CommandInput>();
const sandboxRunOptions: SandboxRunOptions = { waitUntilRunning: false };
expectTypeOf(sandboxRunOptions.waitUntilRunning).toEqualTypeOf<boolean | undefined>();
expectTypeOf(client.create()).toEqualTypeOf<ReturnType<SandboxClient["create"]>>();
expectTypeOf(client.create({ waitUntilRunning: false })).toEqualTypeOf<
  ReturnType<SandboxClient["create"]>
>();
expectTypeOf(client.withSandbox(async (sandbox) => sandbox.sandboxId)).toEqualTypeOf<
  Promise<string>
>();
expectTypeOf(
  client.withSandbox(["python"], async (sandbox) => sandbox.sandboxId, {
    waitUntilRunning: true,
  }),
).toEqualTypeOf<Promise<string>>();
expectTypeOf(client.run(["echo"])).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(
  client.run(["python", "/workspace/main.py"], {
    mountedFiles: {
      "/workspace/main.py": "print('hello')",
    },
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(
  client.run(["python", "/workspace/main.py"], {
    mountedFiles: [
      {
        content: new Uint8Array([1, 2, 3]),
        path: "/workspace/data.bin",
      },
    ],
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(
  client.run(["python"], {
    resources: {
      cpu: "2",
      memory: "4Gi",
    },
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(
  client.run(["python"], {
    resources: {
      limits: { cpu: "4", memory: "8Gi" },
      requests: { cpu: "1", memory: "1Gi" },
    },
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(
  client.run(["python"], {
    profileIds: ["profile-id"],
    profileNames: ["profile-name"],
    runnerIds: ["runner-id"],
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(
  client.run(["python", "-m", "http.server", "8000"], {
    network: {
      egressMode: "internet",
      exposedPorts: [8000],
      ingressMode: "public",
    },
    ports: [8000],
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(
  client.run(["python", "-m", "http.server", "8000"], {
    ports: [{ name: "http", port: 8000, protocol: "TCP" }],
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
const tags = ["project-demo", "purpose-smoke"] as const satisfies readonly SandboxTag[];
expectTypeOf(
  client.run(["python"], {
    tags,
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(client.list({ tags })).toEqualTypeOf<Promise<ListSandboxesResult>>();
const annotations = {
  purpose: "smoke-test",
  team: "platform",
} as const satisfies SandboxAnnotations;
expectTypeOf(
  client.run(["python"], {
    annotations,
    waitUntilRunning: false,
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();

const command: string[] = ["echo"];
expectTypeOf(client.run(command)).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();

const commandInput: CommandInput = command;
expectTypeOf(command).toExtend<CommandInput>();

const portInput: PortInput = { port: 8000, protocol: "TCP" };
const portOptions: PortOptions = { name: "http", port: 8000 };
const sandboxAnnotations: SandboxAnnotations = { team: "platform" };
const sandboxTag: SandboxTag = "project-demo";
const sandboxExposedPort: SandboxExposedPort = { name: "http", port: 8000, protocol: "TCP" };
const sandboxResourceSpec: SandboxResourceSpec = { cpu: "1", memory: "1Gi" };
const sandboxMetadata: SandboxMetadata = {
  appliedEgressMode: "internet",
  appliedIngressMode: "public",
  exposedPorts: [sandboxExposedPort],
  profileId: "profile-id",
  resourceLimits: sandboxResourceSpec,
  resourceRequests: sandboxResourceSpec,
  runnerGroupId: "runner-group-id",
  runnerId: "runner-id",
  sandboxId: "sandbox-id",
  serviceAddress: "sandbox.example.com",
  startedAt: new Date(),
  status: "running",
  statusReason: "ready",
};
const sandboxInfo: SandboxInfo = {
  ...sandboxMetadata,
  status: "running",
};
const startSandboxResult: StartSandboxResult = sandboxMetadata;
const networkOptions: NetworkOptions = {
  egressMode: "internet",
  exposedPorts: [8000],
  ingressMode: "public",
};
expectTypeOf(portInput).toExtend<PortInput>();
expectTypeOf(portOptions).toExtend<PortInput>();
expectTypeOf(sandboxAnnotations).toExtend<SandboxAnnotations>();
expectTypeOf(sandboxTag).toExtend<SandboxTag>();
expectTypeOf(sandboxExposedPort).toExtend<SandboxExposedPort>();
expectTypeOf(sandboxResourceSpec).toExtend<SandboxResourceSpec>();
expectTypeOf(sandboxMetadata).toExtend<SandboxMetadata>();
expectTypeOf(sandboxInfo).toExtend<SandboxInfo>();
expectTypeOf(startSandboxResult).toExtend<StartSandboxResult>();
expectTypeOf(networkOptions).toExtend<NetworkOptions>();

const sandbox = await client.run(["echo"]);
expectTypeOf(sandbox.status).toEqualTypeOf<SandboxStatus | undefined>();
expectTypeOf(sandbox.startedAt).toEqualTypeOf<Date | undefined>();
expectTypeOf(sandbox.runnerId).toEqualTypeOf<string | undefined>();
expectTypeOf(sandbox.runnerGroupId).toEqualTypeOf<string | undefined>();
expectTypeOf(sandbox.profileId).toEqualTypeOf<string | undefined>();
expectTypeOf(sandbox.serviceAddress).toEqualTypeOf<string | undefined>();
expectTypeOf(sandbox.exposedPorts).toEqualTypeOf<readonly SandboxExposedPort[] | undefined>();
expectTypeOf(sandbox.appliedIngressMode).toEqualTypeOf<string | undefined>();
expectTypeOf(sandbox.appliedEgressMode).toEqualTypeOf<string | undefined>();
expectTypeOf(sandbox.resourceRequests).toEqualTypeOf<SandboxResourceSpec | undefined>();
expectTypeOf(sandbox.resourceLimits).toEqualTypeOf<SandboxResourceSpec | undefined>();
expectTypeOf(sandbox.statusReason).toEqualTypeOf<string | undefined>();
expectTypeOf(sandbox.inspect()).toEqualTypeOf<Promise<GetSandboxResult>>();
expectTypeOf(sandbox.inspect({ timeoutMs: 1 })).toEqualTypeOf<Promise<GetSandboxResult>>();
expectTypeOf(sandbox.shell()).toEqualTypeOf<Promise<TerminalSession>>();
expectTypeOf(sandbox.shell({ cols: 80, rows: 24 })).toEqualTypeOf<Promise<TerminalSession>>();
expectTypeOf(sandbox.commands.run(command)).toEqualTypeOf<
  ReturnType<typeof sandbox.commands.run>
>();
expectTypeOf(sandbox.commands.run(command, { bufferedMaxKiB: 64 })).toEqualTypeOf<
  ReturnType<typeof sandbox.commands.run>
>();
expectTypeOf(sandbox.commands.run(command, { check: true })).toEqualTypeOf<
  ReturnType<typeof sandbox.commands.run>
>();
const commandProcess = await sandbox.commands.start(command, { bufferedMaxKiB: 64 });
expectTypeOf(commandProcess).toExtend<CommandProcess>();
expectTypeOf(commandProcess.status).toEqualTypeOf<CommandProcessStatus>();
expectTypeOf(commandProcess.exitCode).toEqualTypeOf<number | undefined>();
expectTypeOf(commandProcess.poll()).toEqualTypeOf<number | undefined>();
expectTypeOf(commandProcess.stdout).toEqualTypeOf<CommandOutputStream>();
expectTypeOf(commandProcess.stderr).toEqualTypeOf<CommandOutputStream>();
expectTypeOf(commandProcess.wait()).toEqualTypeOf<
  Promise<Awaited<ReturnType<typeof sandbox.commands.run>>>
>();
expectTypeOf(commandProcess.cancel()).toEqualTypeOf<Promise<void>>();
const commandProcessWithStdin = await sandbox.commands.start(command, { stdin: true });
expectTypeOf(commandProcessWithStdin).toExtend<CommandProcessWithStdin>();
expectTypeOf(commandProcessWithStdin.stdin).toEqualTypeOf<CommandInputWriter>();
expectTypeOf(commandProcessWithStdin.stdin.closed).toEqualTypeOf<boolean>();
expectTypeOf(commandProcessWithStdin.stdin.write("hello")).toEqualTypeOf<Promise<void>>();
expectTypeOf(commandProcessWithStdin.stdin.write(new Uint8Array([1]))).toEqualTypeOf<
  Promise<void>
>();
expectTypeOf(commandProcessWithStdin.stdin.writeln("hello")).toEqualTypeOf<Promise<void>>();
expectTypeOf(commandProcessWithStdin.stdin.close()).toEqualTypeOf<Promise<void>>();
const stdinOptions = { stdin: true } satisfies StartCommandOptionsWithStdin;
expectTypeOf(sandbox.commands.start(command, stdinOptions)).toEqualTypeOf<
  Promise<CommandProcessWithStdin>
>();
expectTypeOf(sandbox.commands.start(command, { check: true })).toEqualTypeOf<
  Promise<CommandProcess>
>();
expectTypeOf(sandbox.exec(command, { check: true })).toEqualTypeOf<Promise<ProcessResult>>();
const executionError = new CWSandboxExecutionError(await sandbox.commands.run(command));
expectTypeOf(executionError.result).toEqualTypeOf<ProcessResult>();
const terminal = await sandbox.shell();
expectTypeOf(terminal.command).toEqualTypeOf<Command>();
expectTypeOf(terminal.exitCode).toEqualTypeOf<number | undefined>();
expectTypeOf(terminal.output).toEqualTypeOf<AsyncIterable<Uint8Array>>();
expectTypeOf(terminal.stdin).toEqualTypeOf<CommandInputWriter>();
expectTypeOf(terminal.status).toEqualTypeOf<CommandProcessStatus>();
expectTypeOf(terminal.cancel()).toEqualTypeOf<Promise<void>>();
expectTypeOf(terminal.poll()).toEqualTypeOf<number | undefined>();
expectTypeOf(terminal.resize(120, 40)).toEqualTypeOf<Promise<void>>();
expectTypeOf(terminal.wait()).toEqualTypeOf<Promise<TerminalResult>>();
expectTypeOf(sandbox.files.write("/tmp/a.txt", "hello")).toEqualTypeOf<Promise<void>>();
const fileWritesRecord: FileWrites = {
  "/tmp/a.txt": "hello",
  "/tmp/b.bin": new Uint8Array([1, 2, 3]),
};
const fileWrite: FileWrite = { content: "hello", path: "/tmp/a.txt" };
const fileWritesArray: FileWrites = [
  fileWrite,
  { content: new Uint8Array([1, 2, 3]), path: "/tmp/b.bin" },
];
const mountedFileContent: MountedFileContent = "print('hello')";
const mountedFile: MountedFile = { content: mountedFileContent, path: "/workspace/main.py" };
const mountedFiles: MountedFiles = [mountedFile];
const resourceRequestsAndLimits: ResourceRequestsAndLimits = {
  limits: { cpu: "2", memory: "2Gi" },
  requests: { cpu: "1", memory: "1Gi" },
};
expectTypeOf(sandbox.files.write(fileWritesRecord)).toEqualTypeOf<Promise<void>>();
expectTypeOf(sandbox.files.write(fileWritesArray, { timeoutMs: 1 })).toEqualTypeOf<Promise<void>>();
expectTypeOf(sandbox.files.read("/tmp/a.txt")).toEqualTypeOf<Promise<Uint8Array>>();
expectTypeOf(sandbox.files.read(["/tmp/a.txt", "/tmp/b.bin"])).toEqualTypeOf<
  Promise<FileReadResult>
>();
expectTypeOf(sandbox.files.readText("/tmp/a.txt")).toEqualTypeOf<Promise<string>>();
expectTypeOf(sandbox.files.readText(["/tmp/a.txt", "/tmp/b.txt"])).toEqualTypeOf<
  Promise<FileTextReadResult>
>();
expectTypeOf(sandbox.logs.read({ tailLines: 100 })).toEqualTypeOf<Promise<string[]>>();
expectTypeOf(sandbox.logs.stream({ follow: true })).toEqualTypeOf<Promise<LogStream>>();
expectTypeOf(sandbox.logs.streamEntries({ timestamps: true })).toEqualTypeOf<
  Promise<LogEntryStream>
>();
expectTypeOf(sandbox.logs.streamRaw()).toEqualTypeOf<Promise<LogRawStream>>();
const logStreamOptions: LogStreamOptions = {
  follow: true,
  resume: { offset: 1n, sessionId: "session-1" },
};
const logReadOptions: LogReadOptions = { tailLines: 10 };
const logResumeCursor: LogResumeCursor = { offset: "1", sessionId: "session-1" };
const logEntry: LogEntry = { line: "hello\n", offset: "1", sessionId: "session-1" };
const logRawChunk: LogRawChunk = {
  data: new Uint8Array([1]),
  text: "hello",
};
expectTypeOf(logStreamOptions).toExtend<LogStreamOptions>();
expectTypeOf(logReadOptions).toExtend<LogReadOptions>();
expectTypeOf(logResumeCursor).toExtend<LogResumeCursor>();
expectTypeOf(logEntry).toExtend<LogEntry>();
expectTypeOf(logRawChunk).toExtend<LogRawChunk>();
expectTypeOf(client.fromId("sandbox-123")).toEqualTypeOf<Promise<typeof sandbox>>();
expectTypeOf(client.get("sandbox-123")).toEqualTypeOf<Promise<GetSandboxResult>>();
expectTypeOf(client.get("sandbox-123", { timeoutMs: 1 })).toEqualTypeOf<
  Promise<GetSandboxResult>
>();
expectTypeOf(client.list()).toEqualTypeOf<Promise<ListSandboxesResult>>();
expectTypeOf(client.delete("sandbox-123")).toEqualTypeOf<Promise<void>>();
expectTypeOf(sandbox.stop({ gracefulShutdownSeconds: 5, snapshotOnStop: true })).toEqualTypeOf<
  Promise<void>
>();
expectTypeOf(sandbox.delete()).toEqualTypeOf<Promise<void>>();

const waitTarget: WaitTargetStatus = "completed";
const waitOptions: WaitOptions = { targetStatus: waitTarget };
expectTypeOf(waitOptions.targetStatus).toEqualTypeOf<WaitTargetStatus | undefined>();

// @ts-expect-error Unsupported terminal failure states are not valid wait targets.
const invalidWaitOptions: WaitOptions = { targetStatus: "failed" };

// @ts-expect-error Batch writes receive options as the second argument, not content.
sandbox.files.write(fileWritesArray, "hello");

// @ts-expect-error Batch reads only accept arrays, not record inputs.
sandbox.files.read({ "/tmp/a.txt": true });

// @ts-expect-error stdin is only present when commands.start receives { stdin: true }.
commandProcess.stdin.write("hello");

// @ts-expect-error logs.read is finite and does not accept follow: true.
sandbox.logs.read({ follow: true });

void invalidWaitOptions;
void commandInput;
void commandProcess;
void commandProcessWithStdin;
void executionError;
void terminal;
void fileWrite;
void fileWritesRecord;
void fileWritesArray;
void mountedFileContent;
void mountedFile;
void mountedFiles;
void resourceRequestsAndLimits;
void portInput;
void portOptions;
void sandboxAnnotations;
void sandboxExposedPort;
void sandboxResourceSpec;
void sandboxMetadata;
void sandboxInfo;
void startSandboxResult;
void sandboxTag;
void networkOptions;
void logStreamOptions;
void logReadOptions;
void logResumeCursor;
void logEntry;
void logRawChunk;
