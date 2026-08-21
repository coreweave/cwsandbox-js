// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxNotFoundError,
  CWSandboxTimeoutError,
  type Command,
  type CommandInputData,
  type CommandInputWriter,
  type CommandProcessWithStdin,
  type ExecOptions,
  type ProcessResult,
  type Sandbox,
  type SandboxClient,
  type SandboxCommands,
  type SandboxFiles,
  type SandboxListOptions,
  type SandboxLogs,
  type SandboxRunOptions,
  type SandboxStatus,
  type ServiceUrl,
  type StartCommandOptions,
} from "@coreweave/cwsandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { coreweave } from "./index.js";

const encoder = new TextEncoder();

describe("coreweave ComputeSDK provider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("creates sandboxes with resource, owner tag, and name annotation mapping", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client, ownerTag: "matt" });

    const sandbox = await provider.sandbox.create({
      cpu: 8,
      memoryMiB: 16384,
      image: "ubuntu:24.04",
      envs: { API_TOKEN: "secret" },
      name: "demo",
    });

    expect(provider.name).toBe("coreweave");
    expect(sandbox.sandboxId).toBe("sandbox-1");
    expect(tracking.createOptions[0]).toMatchObject({
      containerImage: "ubuntu:24.04",
      environmentVariables: { API_TOKEN: "secret" },
      resources: { cpu: "8", memory: "16384Mi" },
      tags: ["computesdk", "matt"],
      annotations: { name: "demo" },
      waitUntilRunning: true,
    });
    expect(tracking.createOptions[0]?.timeoutMs).toBeUndefined();
  });

  it("auto-generates a 6-char owner tag when omitted", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client });

    await provider.sandbox.create({});
    await provider.sandbox.create({});

    const firstTags = tracking.createOptions[0]?.tags;
    const secondTags = tracking.createOptions[1]?.tags;
    expect(firstTags).toEqual(["computesdk", expect.stringMatching(/^[a-z0-9]{6}$/)]);
    expect(secondTags).toEqual(firstTags);
  });

  it("maps CreateSandboxOptions.timeout to maxLifetimeSeconds", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client, ownerTag: "t1" });

    await provider.sandbox.create({ timeout: 300_000 });

    expect(tracking.createOptions[0]).toMatchObject({
      maxLifetimeSeconds: 300,
    });
    expect(tracking.createOptions[0]?.timeoutMs).toBeUndefined();
  });

  it("runs commands with /usr/bin/env, /bin/sh -c, and native cwd", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client, ownerTag: "t1" });
    const sandbox = await provider.sandbox.create({});

    const result = await sandbox.runCommand("printf ok", {
      cwd: "/workspace/app",
      env: { FROM_PROCESS: "yes" },
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(tracking.execCommands[0]).toEqual([
      "/usr/bin/env",
      "FROM_PROCESS=yes",
      "/bin/sh",
      "-c",
      "printf ok",
    ]);
    expect(tracking.execOptions[0]).toMatchObject({ cwd: "/workspace/app" });
  });

  it("uses commands.start for long-timeout commands only", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client, ownerTag: "t1" });
    const sandbox = await provider.sandbox.create({});

    const result = await sandbox.runCommand("printf stream", {
      timeout: 300_000,
    });

    expect(tracking.startCommands).toHaveLength(1);
    expect(tracking.execCommands).toHaveLength(0);
    expect(result.stdout).toBe("stream");
  });

  it("does not select provider streaming for onStdout alone", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client, ownerTag: "t1" });
    const sandbox = await provider.sandbox.create({});

    // ComputeSDK owns callback streaming via daemond; getUrl alone does not enable
    // callbacks. Our adapter must not treat onStdout as a signal to use commands.start.
    await expect(sandbox.runCommand("printf ok", { onStdout: () => undefined })).rejects.toThrow(
      /not valid JSON/,
    );
    expect(tracking.startCommands).toHaveLength(0);
    expect(tracking.execCommands.length).toBeGreaterThan(0);
  });

  it("memoizes createClient across create/list/destroy", async () => {
    const tracking = createTrackingClient();
    let createClientCalls = 0;
    const provider = coreweave({
      ownerTag: "t1",
      createClient: () => {
        createClientCalls += 1;
        return tracking.client;
      },
    });

    const sandbox = await provider.sandbox.create({});
    await provider.sandbox.list();
    await sandbox.destroy();
    await provider.sandbox.create({});

    expect(createClientCalls).toBe(1);
  });

  it("lists only adapter+owner tagged sandboxes", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client, ownerTag: "matt" });

    await provider.sandbox.list();

    expect(tracking.listAllOptions[0]).toEqual({ tags: ["computesdk", "matt"] });
  });

  it("creates parent directories before nested writes", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client, ownerTag: "t1" });
    const sandbox = await provider.sandbox.create({});

    await sandbox.filesystem.writeFile("/tmp/a/b/c.txt", "hello");

    expect(tracking.execCommands[0]).toEqual(["/bin/sh", "-c", "mkdir -p '/tmp/a/b'"]);
    expect(tracking.writeRequests[0]).toEqual({
      path: "/tmp/a/b/c.txt",
      content: "hello",
    });
  });

  it("reads directories with portable ls -la", async () => {
    const tracking = createTrackingClient({
      runStdout:
        "total 8\ndrwxr-xr-x 2 root root 4096 Jan 1 00:00 .\ndrwxr-xr-x 3 root root 4096 Jan 1 00:00 ..\n-rw-r--r-- 1 root root   11 Jan 1 00:00 hello.txt\ndrwxr-xr-x 2 root root 4096 Jan 1 00:00 nested\n",
    });
    const provider = coreweave({ client: tracking.client, ownerTag: "t1" });
    const sandbox = await provider.sandbox.create({});

    const entries = await sandbox.filesystem.readdir("/tmp/smoke");

    expect(tracking.execCommands[0]).toEqual(["/bin/sh", "-c", "ls -la '/tmp/smoke'"]);
    expect(entries).toEqual([
      { name: "hello.txt", type: "file", size: 11 },
      { name: "nested", type: "directory", size: 4096 },
    ]);
  });

  it("maps inspect not-found to stopped and rethrows other getInfo errors", async () => {
    const notFound = createTrackingClient({
      inspectError: new CWSandboxNotFoundError("gone"),
    });
    const providerNotFound = coreweave({ client: notFound.client, ownerTag: "t1" });
    const sandboxNotFound = await providerNotFound.sandbox.create({});
    await expect(sandboxNotFound.getInfo()).resolves.toMatchObject({
      id: "sandbox-1",
      status: "stopped",
    });

    const other = createTrackingClient({
      inspectError: new Error("rate limited"),
    });
    const providerOther = coreweave({ client: other.client, ownerTag: "t1" });
    const sandboxOther = await providerOther.sandbox.create({});
    await expect(sandboxOther.getInfo()).rejects.toThrow(/rate limited/);
  });

  it("returns null for missing sandboxes on getById", async () => {
    const provider = coreweave({ client: createTrackingClient().client, ownerTag: "t1" });

    await expect(provider.sandbox.getById("sandbox-1")).resolves.toMatchObject({
      sandboxId: "sandbox-1",
    });
    await expect(provider.sandbox.getById("missing")).resolves.toBeNull();
  });

  it("destroys sandboxes through the client", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client, ownerTag: "t1" });
    const sandbox = await provider.sandbox.create({});

    await sandbox.destroy();
    await provider.sandbox.destroy("sandbox-2");

    expect(tracking.deletedSandboxIds).toEqual(["sandbox-1", "sandbox-2"]);
  });

  it("fails clearly for getUrl when assignment never arrives", async () => {
    vi.useFakeTimers();
    const provider = coreweave({ client: createTrackingClient().client, ownerTag: "t1" });
    const sandbox = await provider.sandbox.create({});

    const url = sandbox.getUrl({ port: 8080 });
    const drive = vi.advanceTimersByTimeAsync(60_000);
    await expect(url).rejects.toThrow(/no assigned HTTPS URL for port 8080 after 60000ms/);
    await drive;
  });

  it("forwards runnerIds from config and create", async () => {
    const tracking = createTrackingClient();
    const fromConfig = coreweave({
      client: tracking.client,
      ownerTag: "t1",
      runnerIds: ["runner-a"],
    });

    await fromConfig.sandbox.create({});

    expect(tracking.createOptions[0]?.runnerIds).toEqual(["runner-a"]);

    const fromCreate = coreweave({ client: tracking.client, ownerTag: "t1" });
    await fromCreate.sandbox.create({ runnerIds: ["runner-b"] });

    expect(tracking.createOptions[1]?.runnerIds).toEqual(["runner-b"]);
  });

  it("forwards services and selects getUrl by port", async () => {
    const tracking = createTrackingClient({
      serviceUrls: [
        { name: "http-a", port: 8000, url: "https://a.example" },
        { name: "http-b", port: 8001, url: "https://b.example" },
      ],
    });
    const provider = coreweave({ client: tracking.client, ownerTag: "t1" });
    const services = [
      {
        endpoint: { auth: "open" as const, kind: "https" as const },
        name: "http-a",
        port: 8000,
        visibility: "public" as const,
      },
      {
        endpoint: { auth: "open" as const, kind: "https" as const },
        name: "http-b",
        port: 8001,
        visibility: "public" as const,
      },
    ];

    const sandbox = await provider.sandbox.create({
      network: { denyEgress: false },
      services,
    });

    expect(tracking.createOptions[0]?.services).toEqual(services);
    expect(tracking.createOptions[0]?.network).toEqual({ denyEgress: false });
    await expect(sandbox.getUrl({ port: 8001 })).resolves.toBe("https://b.example");
    await expect(sandbox.getUrl({ port: 8000 })).resolves.toBe("https://a.example");
  });

  it("polls inspect until the requested port is assigned", async () => {
    vi.useFakeTimers();
    const tracking = createTrackingClient({
      inspectServiceUrls: [undefined, [{ name: "http-b", port: 8001, url: "https://b.example" }]],
    });
    const provider = coreweave({ client: tracking.client, ownerTag: "t1" });
    const sandbox = await provider.sandbox.create({
      services: [
        {
          endpoint: { auth: "open", kind: "https" },
          name: "http-b",
          port: 8001,
          visibility: "public",
        },
      ],
    });

    const url = sandbox.getUrl({ port: 8001 });
    const drive = vi.advanceTimersByTimeAsync(500);
    await expect(url).resolves.toBe("https://b.example");
    await drive;
    expect(tracking.inspectCalls).toBeGreaterThan(1);
  });

  it("times out when getUrl port is missing among assigned URLs", async () => {
    vi.useFakeTimers();
    const tracking = createTrackingClient({
      serviceUrls: [
        { name: "http-a", port: 8000, url: "https://a.example" },
        { name: "http-b", port: 8001, url: "https://b.example" },
      ],
    });
    const provider = coreweave({ client: tracking.client, ownerTag: "t1" });
    const sandbox = await provider.sandbox.create({});

    const url = sandbox.getUrl({ port: 9999 });
    const drive = vi.advanceTimersByTimeAsync(60_000);
    await expect(url).rejects.toThrow(/no assigned HTTPS URL for port 9999 after 60000ms/);
    await drive;
  });

  it("fails getUrl with the inspect timeout when inspect never resolves", async () => {
    vi.useFakeTimers();
    const tracking = createTrackingClient({ hungInspect: true });
    const provider = coreweave({ client: tracking.client, ownerTag: "t1" });
    const sandbox = await provider.sandbox.create({});

    const url = sandbox.getUrl({ port: 8080 });
    const drive = vi.advanceTimersByTimeAsync(60_000);
    await expect(url).rejects.toThrow(CWSandboxTimeoutError);
    await drive;
  });

  it("rejects invalid ownerTag", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client, ownerTag: "bad tag" });

    await expect(provider.sandbox.create({})).rejects.toThrow(/Invalid ownerTag/);
  });
});

interface WriteRequest {
  readonly content: string;
  readonly path: string;
}

interface TrackingClientOptions {
  readonly hungInspect?: boolean;
  readonly inspectError?: Error;
  readonly inspectServiceUrls?: ReadonlyArray<readonly ServiceUrl[] | undefined>;
  readonly runStdout?: string;
  readonly serviceUrls?: readonly ServiceUrl[];
}

interface TrackingClient {
  readonly client: SandboxClient;
  readonly createOptions: SandboxRunOptions[];
  readonly deletedSandboxIds: string[];
  readonly execCommands: Command[];
  readonly execOptions: Array<ExecOptions | undefined>;
  readonly inspectCalls: number;
  readonly listAllOptions: Array<SandboxListOptions | undefined>;
  readonly startCommands: Command[];
  readonly writeRequests: WriteRequest[];
}

function createTrackingClient(options: TrackingClientOptions = {}): TrackingClient {
  const createOptions: SandboxRunOptions[] = [];
  const deletedSandboxIds: string[] = [];
  const execCommands: Command[] = [];
  const execOptions: Array<ExecOptions | undefined> = [];
  const listAllOptions: Array<SandboxListOptions | undefined> = [];
  const startCommands: Command[] = [];
  const writeRequests: WriteRequest[] = [];
  let inspectCalls = 0;
  let sandboxCounter = 0;

  function createFakeSandbox(sandboxId: string, status: SandboxStatus = "running"): Sandbox {
    const files: SandboxFiles = {
      read: (async () => new Uint8Array()) as unknown as SandboxFiles["read"],
      readStream: () => emptyBinaryIterable(),
      readText: (async (filePath: string) => {
        if (filePath === "/workspace/app/output.txt") {
          return "file contents";
        }
        return "";
      }) as unknown as SandboxFiles["readText"],
      write: (async (filePath: string, content: string | Uint8Array) => {
        writeRequests.push({
          content: typeof content === "string" ? content : new TextDecoder().decode(content),
          path: filePath,
        });
      }) as unknown as SandboxFiles["write"],
      writeStream: async () => undefined,
    };

    const commands: SandboxCommands = {
      run: async (command, runOptions?: ExecOptions) => {
        const normalized = normalizeCommand(command);
        execCommands.push(normalized);
        execOptions.push(runOptions);
        return createProcessResult(normalized, {
          stdout: options.runStdout ?? "ok",
        });
      },
      start: (async (command, startOptions?: StartCommandOptions) => {
        const normalized = normalizeCommand(command);
        startCommands.push(normalized);
        execOptions.push(startOptions);
        return createCommandProcess(normalized, { stdout: "stream" });
      }) as SandboxCommands["start"],
    };

    const logs: SandboxLogs = {
      read: async () => {
        throw new Error("Logs not used");
      },
      stream: async () => {
        throw new Error("Logs not used");
      },
      streamEntries: async () => {
        throw new Error("Logs not used");
      },
      streamRaw: async () => {
        throw new Error("Logs not used");
      },
    };

    const sandbox: Sandbox = {
      commands,
      delete: async () => {
        deletedSandboxIds.push(sandboxId);
      },
      exec: async (command) => createProcessResult(normalizeCommand(command), { stdout: "ok" }),
      exitCode: undefined,
      exposedPorts: undefined,
      files,
      getStatus: async () => status,
      inspect: async (requestOptions?: { timeoutMs?: number }) => {
        if (options.hungInspect === true) {
          if (requestOptions?.timeoutMs === undefined) {
            throw new Error("inspect timeoutMs is required");
          }
          await new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(
                new CWSandboxTimeoutError(`inspect timed out after ${requestOptions.timeoutMs}ms`),
              );
            }, requestOptions.timeoutMs);
          });
        }
        if (options.inspectError !== undefined) {
          throw options.inspectError;
        }
        inspectCalls += 1;
        const sequence = options.inspectServiceUrls;
        const serviceUrls =
          sequence === undefined
            ? options.serviceUrls
            : sequence[Math.min(inspectCalls - 1, sequence.length - 1)];
        return {
          sandboxId,
          ...(serviceUrls === undefined ? {} : { serviceUrls }),
          status,
        };
      },
      logs,
      resourceLimits: undefined,
      resourceRequests: undefined,
      runnerGroupId: undefined,
      runnerId: undefined,
      sandboxId,
      serviceUrls: undefined,
      shell: async () => {
        throw new Error("Shell not used");
      },
      snapshot: async () => {
        throw new Error("Snapshot not used");
      },
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      status,
      statusReason: undefined,
      stop: async () => undefined,
      wait: async () => sandbox,
      async [Symbol.asyncDispose]() {
        await sandbox.stop();
      },
    };
    return sandbox;
  }

  const client: SandboxClient = {
    async create(createOpts = {}) {
      sandboxCounter++;
      createOptions.push(createOpts);
      return createFakeSandbox(`sandbox-${sandboxCounter}`);
    },
    async run(_, createOpts = {}) {
      sandboxCounter++;
      createOptions.push(createOpts);
      return createFakeSandbox(`sandbox-${sandboxCounter}`);
    },
    async get(sandboxId) {
      if (sandboxId === "missing") {
        throw new CWSandboxNotFoundError("Sandbox not found.");
      }
      return { sandboxId, status: "running" };
    },
    async fromId(sandboxId) {
      if (sandboxId === "missing") {
        throw new CWSandboxNotFoundError("Sandbox not found.");
      }
      return createFakeSandbox(sandboxId);
    },
    async list() {
      return { sandboxes: [] };
    },
    listSandboxes() {
      throw new Error("listSandboxes not used in these tests.");
    },
    async listAll(listOpts) {
      listAllOptions.push(listOpts);
      return [createFakeSandbox("sandbox-listed")];
    },
    async delete(sandboxId) {
      deletedSandboxIds.push(sandboxId);
    },
    async deleteSnapshot() {
      throw new Error("deleteSnapshot not used in these tests.");
    },
    async withSandbox() {
      throw new Error("withSandbox not used in these tests.");
    },
  };

  return {
    client,
    createOptions,
    deletedSandboxIds,
    execCommands,
    execOptions,
    get inspectCalls() {
      return inspectCalls;
    },
    listAllOptions,
    startCommands,
    writeRequests,
  };
}

function normalizeCommand(command: Command | readonly string[]): Command {
  if (command.length === 0) {
    throw new Error("command must be non-empty");
  }
  return command as Command;
}

function createProcessResult(
  command: Command,
  overrides: Partial<ProcessResult> = {},
): ProcessResult {
  const stdout = overrides.stdout ?? "";
  const stderr = overrides.stderr ?? "";
  const stdoutBytes = encoder.encode(stdout);
  const stderrBytes = encoder.encode(stderr);
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
  };
}

function createCommandProcess(
  command: Command,
  overrides: Partial<ProcessResult> = {},
): CommandProcessWithStdin {
  const stdout = overrides.stdout ?? "ok";
  return {
    cancel: async () => undefined,
    command,
    exitCode: 0,
    poll() {
      return 0;
    },
    status: "exited",
    stderr: streamFrom([]),
    stdin: createCommandInputWriter(),
    stdout: streamFrom([stdout]),
    async wait() {
      return createProcessResult(command, { stdout });
    },
  };
}

function createCommandInputWriter(): CommandInputWriter {
  return {
    closed: false,
    close: async () => undefined,
    write: async (_data: CommandInputData) => undefined,
    writeln: async (_text: string) => undefined,
  };
}

async function* streamFrom(values: readonly string[]): AsyncIterable<string> {
  for (const value of values) {
    yield value;
  }
}

async function* emptyBinaryIterable(): AsyncIterable<Uint8Array> {}
