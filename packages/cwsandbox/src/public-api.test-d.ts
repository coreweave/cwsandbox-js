// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { expectTypeOf } from "vitest";

import {
  CWSandboxExecutionError,
  DEFAULT_GRACEFUL_SHUTDOWN_SECONDS,
  DEFAULT_KEEP_ALIVE_COMMAND,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  type Command,
  type CommandInputWriter,
  type CommandProcess,
  type CommandOutputStream,
  type CommandInput,
  type CommandProcessWithStdin,
  type CommandProcessStatus,
  type DataPlaneMode,
  type FileReadResult,
  type FileTextReadResult,
  type FileWrite,
  type FileWrites,
  type FileSystemSnapshotOptions,
  type FileSystemSnapshotResult,
  type ScratchVolumeOptions,
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
  type Endpoint,
  type NetworkOptions,
  type EgressRule,
  type ObjectStoragePermission,
  type ProcessResult,
  type ResourceRequestsAndLimits,
  type Sandbox,
  type SandboxAnnotations,
  type SandboxClient,
  type SandboxExposedPort,
  type SandboxInfo,
  type SandboxList,
  type SandboxListOptions,
  type SandboxMetadata,
  type SandboxObjectStorageAccess,
  type SandboxResourceSpec,
  type SandboxRunFromTemplateOptions,
  type SandboxRunOptions,
  type SandboxStatus,
  type SandboxTag,
  type SecretInput,
  type Secrets,
  type Service,
  type ServiceUrl,
  type StartSandboxResult,
  type StartCommandOptionsWithStdin,
  type TerminalResult,
  type TerminalSession,
  type WaitOptions,
  type WaitTargetStatus,
} from "./index.js";
import {
  createSandboxClient,
  createSandboxClientFromEnv,
  type NodeSandboxClientOptions,
  type CWSandboxEnvironment,
} from "./node/index.js";
import {
  createSandboxClient as createWandbSubpathClient,
  createSandboxClientFromEnv as createWandbSubpathClientFromEnv,
  type WandbSandboxClientOptions,
  type WandbSandboxEnvironment,
} from "./wandb/index.js";

const dataPlaneMode: DataPlaneMode = "direct";
const nodeOptions: NodeSandboxClientOptions = { apiKey: "test-key", dataPlaneMode };
const nodeEnv: CWSandboxEnvironment = { CWSANDBOX_API_KEY: "test-key" };
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
expectTypeOf(createSandboxClient(nodeOptions)).toEqualTypeOf<SandboxClient>();
expectTypeOf(createSandboxClientFromEnv(nodeEnv)).toEqualTypeOf<SandboxClient>();
expectTypeOf(createWandbSubpathClient(wandbOptions)).toEqualTypeOf<SandboxClient>();
expectTypeOf(createWandbSubpathClientFromEnv(wandbEnvironment)).toEqualTypeOf<SandboxClient>();

// SandboxClient / Sandbox are type-only interfaces; factories are the supported creation path.
declare const client: SandboxClient;

expectTypeOf(DEFAULT_KEEP_ALIVE_COMMAND).toExtend<CommandInput>();
expectTypeOf(DEFAULT_GRACEFUL_SHUTDOWN_SECONDS).toEqualTypeOf<10>();
expectTypeOf(DEFAULT_SNAPSHOT_TIMEOUT_MS).toEqualTypeOf<600_000>();
const sandboxRunOptions: SandboxRunOptions = { dataPlaneMode: "auto", waitUntilRunning: false };
expectTypeOf(sandboxRunOptions.dataPlaneMode).toEqualTypeOf<DataPlaneMode | undefined>();
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
expectTypeOf(client.runFromTemplate("template-id")).toEqualTypeOf<
  ReturnType<SandboxClient["runFromTemplate"]>
>();
expectTypeOf(client.runFromTemplate("template-id", { tags: ["demo"] })).toEqualTypeOf<
  ReturnType<SandboxClient["runFromTemplate"]>
>();
expectTypeOf(
  client.runFromTemplate("template-id", {
    command: ["/bin/sh", "-c", "echo ready"],
    containerImage: "python:3.11",
  }),
).toEqualTypeOf<ReturnType<SandboxClient["runFromTemplate"]>>();
void client.runFromTemplate("template-id", {
  // @ts-expect-error objectStorageAccess is not part of runFromTemplate
  objectStorageAccess: {
    buckets: ["example-bucket"],
    permission: "read-write",
  },
});
expectTypeOf(
  client.withSandboxFromTemplate("template-id", async (sandbox) => sandbox.sandboxId),
).toEqualTypeOf<Promise<string>>();
expectTypeOf(
  client.withSandboxFromTemplate("template-id", async (sandbox) => sandbox.sandboxId, {
    tags: ["demo"],
  }),
).toEqualTypeOf<Promise<string>>();
const sandboxRunFromTemplateOptions: SandboxRunFromTemplateOptions = {
  containerImage: "python:3.11",
};
expectTypeOf(sandboxRunFromTemplateOptions.containerImage).toEqualTypeOf<string | undefined>();
expectTypeOf(client.runFromTemplate("template-id", { command: ["/bin/sh"] })).toEqualTypeOf<
  ReturnType<SandboxClient["runFromTemplate"]>
>();
// @ts-expect-error positional command is not part of runFromTemplate
void client.runFromTemplate("template-id", ["/bin/sh"]);
expectTypeOf<SandboxMetadata>().not.toHaveProperty("sourceTemplateId");
expectTypeOf<SandboxMetadata>().not.toHaveProperty("sourceTemplateRevision");
expectTypeOf<Sandbox>().not.toHaveProperty("sourceTemplateId");
expectTypeOf<Sandbox>().not.toHaveProperty("sourceTemplateRevision");
expectTypeOf(client.run(["echo"])).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(client.fromId("sandbox-id", { dataPlaneMode: "gateway" })).toEqualTypeOf<
  ReturnType<SandboxClient["fromId"]>
>();
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
    runnerIds: ["runner-id"],
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(
  client.run(["python", "-m", "http.server", "8000"], {
    network: {
      denyEgress: true,
    },
    services: [{ port: 8000 }],
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(
  client.run(["python"], {
    network: {
      egress: [{ dnsName: "pypi.org" }, { dnsName: "*.pypi.org" }],
    },
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(
  client.run(["python", "-m", "http.server", "8000"], {
    services: [
      {
        endpoint: { auth: "open", kind: "https" },
        name: "http",
        port: 8000,
        protocol: "tcp",
        visibility: "public",
      },
    ],
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
const tags = ["project-demo", "purpose-smoke"] as const satisfies readonly SandboxTag[];
expectTypeOf(
  client.run(["python"], {
    tags,
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(client.list({ tags })).toEqualTypeOf<Promise<ListSandboxesResult>>();
expectTypeOf(client.listSandboxes({ tags })).toEqualTypeOf<SandboxList>();
expectTypeOf(client.listAll({ tags })).toEqualTypeOf<Promise<readonly Sandbox[]>>();
const listOptions = {
  pageSize: 25,
  showTerminated: true,
  tags,
  timeoutMs: 1_000,
} as const satisfies SandboxListOptions;
expectTypeOf(client.listSandboxes(listOptions)).toEqualTypeOf<SandboxList>();
expectTypeOf(client.listAll(listOptions)).toEqualTypeOf<Promise<readonly Sandbox[]>>();
expectTypeOf(client.listSandboxes(listOptions).collect()).toEqualTypeOf<
  Promise<readonly Sandbox[]>
>();
expectTypeOf(client.listSandboxes(listOptions).byPage()).toEqualTypeOf<
  AsyncIterable<readonly Sandbox[]>
>();
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

const secret: SecretInput = { store: "wandb-team-secrets", name: "HF_TOKEN" };
const secrets = [
  secret,
  {
    envVar: "DB_PASS",
    field: "password",
    name: "db-credentials",
    store: "wandb-team-secrets",
  },
] as const satisfies Secrets;
expectTypeOf(
  client.run(["python"], {
    secrets,
  }),
).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();
expectTypeOf(
  client.create({
    secrets: [{ store: "wandb-team-secrets", name: "SMOKE_SECRET" }],
  }),
).toEqualTypeOf<ReturnType<SandboxClient["create"]>>();
const fileSystemSnapshot: FileSystemSnapshotOptions = {
  mountPath: "/workspace",
  size: "10Gi",
};
const objectStorageAccess: SandboxObjectStorageAccess = {
  buckets: ["example-bucket"],
  permission: "read-write",
};
expectTypeOf(
  client.create({
    fileSystemSnapshot,
    objectStorageAccess,
  }),
).toEqualTypeOf<ReturnType<SandboxClient["create"]>>();
expectTypeOf(
  client.create({
    fileSystemSnapshot: {
      mountPath: "/workspace",
      restoreFromSnapshotId: "snap-123",
    },
  }),
).toEqualTypeOf<ReturnType<SandboxClient["create"]>>();
const namedVolumes: readonly ScratchVolumeOptions[] = [
  { mountPath: "/workspace", name: "workspace", size: "10Gi" },
  { mountPath: "/cache", name: "cache" },
];
expectTypeOf(
  client.create({
    volumes: namedVolumes,
  }),
).toEqualTypeOf<ReturnType<SandboxClient["create"]>>();
expectTypeOf<ObjectStoragePermission>().toEqualTypeOf<"read" | "read-write">();

const command: string[] = ["echo"];
expectTypeOf(client.run(command)).toEqualTypeOf<ReturnType<SandboxClient["run"]>>();

const commandInput: CommandInput = command;
expectTypeOf(command).toExtend<CommandInput>();

const endpoint: Endpoint = { auth: "open", kind: "https" };
// @ts-expect-error TOKEN is not a supported EndpointAuth
const tokenEndpoint: Endpoint = { auth: "token", kind: "https" };
const stringAuth: string = "open";
// @ts-expect-error Endpoint.auth does not accept a widened string
const stringEndpoint: Endpoint = { auth: stringAuth, kind: "https" };
void tokenEndpoint;
void stringEndpoint;
const service: Service = {
  endpoint,
  name: "http",
  port: 8000,
  protocol: "tcp",
  visibility: "public",
};
const serviceUrl: ServiceUrl = { name: "http", port: 8000, url: "https://sandbox.example.com" };
const sandboxAnnotations: SandboxAnnotations = { team: "platform" };
const sandboxTag: SandboxTag = "project-demo";
const sandboxExposedPort: SandboxExposedPort = { name: "http", port: 8000, protocol: "tcp" };
const sandboxResourceSpec: SandboxResourceSpec = { cpu: "1", memory: "1Gi" };
const sandboxMetadata: SandboxMetadata = {
  dnsEgressNames: ["pypi.org"],
  exposedPorts: [sandboxExposedPort],
  resourceLimits: sandboxResourceSpec,
  resourceRequests: sandboxResourceSpec,
  runnerGroupId: "runner-group-id",
  runnerId: "runner-id",
  sandboxId: "sandbox-id",
  serviceUrls: [serviceUrl],
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
  denyEgress: true,
};
const egressRule: EgressRule = { dnsName: "pypi.org" };
const egressNetwork: NetworkOptions = {
  egress: [egressRule],
};
expectTypeOf(endpoint).toExtend<Endpoint>();
expectTypeOf(service).toExtend<Service>();
expectTypeOf(serviceUrl).toExtend<ServiceUrl>();
expectTypeOf(sandboxAnnotations).toExtend<SandboxAnnotations>();
expectTypeOf(sandboxTag).toExtend<SandboxTag>();
expectTypeOf(sandboxExposedPort).toExtend<SandboxExposedPort>();
expectTypeOf(sandboxResourceSpec).toExtend<SandboxResourceSpec>();
expectTypeOf(sandboxMetadata).toExtend<SandboxMetadata>();
expectTypeOf(sandboxInfo).toExtend<SandboxInfo>();
expectTypeOf(startSandboxResult).toExtend<StartSandboxResult>();
expectTypeOf(networkOptions).toExtend<NetworkOptions>();
expectTypeOf(egressNetwork).toExtend<NetworkOptions>();
expectTypeOf(egressRule).toExtend<EgressRule>();

const sandbox = await client.run(["echo"]);
expectTypeOf(sandbox.status).toEqualTypeOf<SandboxStatus | undefined>();
expectTypeOf(sandbox.exitCode).toEqualTypeOf<number | undefined>();
expectTypeOf(sandbox.startedAt).toEqualTypeOf<Date | undefined>();
expectTypeOf(sandbox.runnerId).toEqualTypeOf<string | undefined>();
expectTypeOf(sandbox.runnerGroupId).toEqualTypeOf<string | undefined>();
expectTypeOf(sandbox.serviceUrls).toEqualTypeOf<readonly ServiceUrl[] | undefined>();
expectTypeOf(sandbox.dnsEgressNames).toEqualTypeOf<readonly string[] | undefined>();
expectTypeOf(sandbox.exposedPorts).toEqualTypeOf<readonly SandboxExposedPort[] | undefined>();
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
expectTypeOf(sandbox.commands.run(command, { check: true })).toEqualTypeOf<
  ReturnType<typeof sandbox.commands.run>
>();
// @ts-expect-error bufferedMaxKiB is not part of public ExecOptions
void sandbox.commands.run(command, { bufferedMaxKiB: 64 });
// @ts-expect-error bufferedMaxKiB is not part of public ExecOptions
void sandbox.exec(command, { bufferedMaxKiB: 64 });
const commandProcess = await sandbox.commands.start(command, { bufferedMaxKiB: 64 });
expectTypeOf(commandProcess).toExtend<CommandProcess>();
expectTypeOf(commandProcess.status).toEqualTypeOf<CommandProcessStatus>();
expectTypeOf(commandProcess.exitCode).toEqualTypeOf<number | undefined>();
expectTypeOf(commandProcess.poll()).toEqualTypeOf<number | undefined>();
expectTypeOf(commandProcess.stdout).toEqualTypeOf<CommandOutputStream>();
expectTypeOf(commandProcess.stderr).toEqualTypeOf<CommandOutputStream>();
// @ts-expect-error public CommandProcess does not expose stdoutBinary
void commandProcess.stdoutBinary;
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
// @ts-expect-error binaryOutput is not part of public StartCommandOptions
void sandbox.commands.start(command, { binaryOutput: true });
// @ts-expect-error streamStdoutOnly is not part of public StartCommandOptions
void sandbox.commands.start(command, { streamStdoutOnly: true });
expectTypeOf(sandbox.exec(command, { check: true })).toEqualTypeOf<Promise<ProcessResult>>();
const executionError = new CWSandboxExecutionError(await sandbox.commands.run(command));
expectTypeOf(executionError.result).toEqualTypeOf<ProcessResult | undefined>();
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
expectTypeOf(client.listSandboxes()).toEqualTypeOf<SandboxList>();
expectTypeOf(client.listAll()).toEqualTypeOf<Promise<readonly Sandbox[]>>();
expectTypeOf(client.delete("sandbox-123")).toEqualTypeOf<Promise<void>>();
expectTypeOf(client.delete("sandbox-123", { missingOk: true })).toEqualTypeOf<Promise<void>>();
expectTypeOf(client.deleteSnapshot("snap-123")).toEqualTypeOf<Promise<void>>();
expectTypeOf(client.deleteSnapshot("snap-123", { missingOk: true })).toEqualTypeOf<Promise<void>>();
expectTypeOf(client.getSnapshot("snap-123")).toEqualTypeOf<Promise<FileSystemSnapshotResult>>();
expectTypeOf(client.listSnapshots()).toEqualTypeOf<Promise<readonly FileSystemSnapshotResult[]>>();
expectTypeOf(client.listSnapshots({ sourceSandboxId: "sbx-1", state: "ready" })).toEqualTypeOf<
  Promise<readonly FileSystemSnapshotResult[]>
>();
expectTypeOf(sandbox.snapshot()).toEqualTypeOf<Promise<FileSystemSnapshotResult>>();
expectTypeOf(sandbox.snapshot({ timeoutMs: 1_000 })).toEqualTypeOf<
  Promise<FileSystemSnapshotResult>
>();

// @ts-expect-error listSandboxes owns pagination and does not accept pageToken.
client.listSandboxes({ pageToken: "page-1" });

// @ts-expect-error listAll owns pagination and does not accept pageToken.
client.listAll({ pageToken: "page-1" });

// @ts-expect-error listSnapshots collects all pages and does not accept pageToken.
client.listSnapshots({ pageToken: "page-1" });

// @ts-expect-error listSnapshots does not accept pageSize.
client.listSnapshots({ pageSize: 10 });

expectTypeOf(sandbox.stop({ gracefulShutdownSeconds: 5 })).toEqualTypeOf<Promise<void>>();
// @ts-expect-error ports is not supported in v1.
void client.run(["python"], { ports: [8000] });

// @ts-expect-error s3Mount is not supported in v1.
void client.run(["python"], { s3Mount: { bucket: "b" } });

void client.create({
  fileSystemSnapshot: {
    mountPath: "/workspace",
    // @ts-expect-error restore uses restoreFromSnapshotId, not snapshotId.
    snapshotId: "snap-123",
  },
});

void client.create({
  fileSystemSnapshot: {
    mountPath: "/workspace",
    // @ts-expect-error convenience snapshot options do not take name.
    name: "workspace",
  },
});

// @ts-expect-error profileIds is not supported in v1.
void client.run(["python"], { profileIds: ["profile-id"] });

// @ts-expect-error profileNames is not supported in v1.
void client.run(["python"], { profileNames: ["default"] });

// @ts-expect-error network.ingressMode is not supported in v1.
void client.run(["python"], { network: { ingressMode: "public" } });

// @ts-expect-error network.egressMode is not supported in v1.
void client.run(["python"], { network: { egressMode: "deny" } });

// @ts-expect-error network.exposedPorts is not supported in v1.
void client.run(["python"], { network: { exposedPorts: [8000] } });

// @ts-expect-error includeStopped is not supported in v1.
void client.listAll({ includeStopped: true });

// @ts-expect-error profileIds is not supported in v1.
void client.listAll({ profileIds: ["profile-id"] });

// @ts-expect-error profileNames is not supported in v1.
void client.listAll({ profileNames: ["default"] });

// @ts-expect-error snapshotOnStop remains unsupported; use sandbox.snapshot().
sandbox.stop({ snapshotOnStop: true });
expectTypeOf(sandbox.stop({ missingOk: true })).toEqualTypeOf<Promise<void>>();
expectTypeOf(sandbox.delete()).toEqualTypeOf<Promise<void>>();
expectTypeOf(sandbox.delete({ missingOk: true })).toEqualTypeOf<Promise<void>>();

const waitTarget: WaitTargetStatus = "completed";
const waitOptions: WaitOptions = { targetStatus: waitTarget };
expectTypeOf(waitOptions.targetStatus).toEqualTypeOf<WaitTargetStatus | undefined>();
const terminalWaitOptions: WaitOptions = { targetStatus: "terminal" };
expectTypeOf(terminalWaitOptions.targetStatus).toEqualTypeOf<WaitTargetStatus | undefined>();

// @ts-expect-error Individual failure states are not valid wait targets; use "terminal".
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
void endpoint;
void service;
void serviceUrl;
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
