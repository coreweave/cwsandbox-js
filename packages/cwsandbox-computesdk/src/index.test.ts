// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxNotFoundError,
  type Command,
  type CommandInputData,
  type CommandInputWriter,
  type CommandProcessWithStdin,
  type ProcessResult,
  type Sandbox,
  type SandboxClient,
  type SandboxCommands,
  type SandboxFiles,
  type SandboxLogs,
  type SandboxRunOptions,
  type SandboxStatus,
} from "@coreweave/cwsandbox";
import { describe, expect, it } from "vitest";

import { coreweave } from "./index.js";

const encoder = new TextEncoder();

describe("coreweave ComputeSDK provider", () => {
  it("creates sandboxes with resource and env mapping", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client });

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
      tags: ["computesdk", "demo"],
      waitUntilRunning: true,
    });
  });

  it("runs commands with cwd/env and returns duration", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client });
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
      "/bin/bash",
      "-c",
      "export FROM_PROCESS='yes'\ncd '/workspace/app'\nprintf ok",
    ]);
  });

  it("uses commands.start for long-timeout commands", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client });
    const sandbox = await provider.sandbox.create({});

    const result = await sandbox.runCommand("printf stream", {
      timeout: 300_000,
    });

    expect(tracking.startCommands).toHaveLength(1);
    expect(tracking.execCommands).toHaveLength(0);
    expect(result.stdout).toBe("stream");
  });

  it("reads and writes files through the SDK filesystem", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client });
    const sandbox = await provider.sandbox.create({});

    await sandbox.filesystem.writeFile("/workspace/app/input.txt", "hello");
    const text = await sandbox.filesystem.readFile("/workspace/app/output.txt");

    expect(text).toBe("file contents");
    expect(tracking.writeRequests[0]).toEqual({
      path: "/workspace/app/input.txt",
      content: "hello",
    });
  });

  it("returns null for missing sandboxes on getById", async () => {
    const provider = coreweave({ client: createTrackingClient().client });

    await expect(provider.sandbox.getById("sandbox-1")).resolves.toMatchObject({
      sandboxId: "sandbox-1",
    });
    await expect(provider.sandbox.getById("missing")).resolves.toBeNull();
  });

  it("destroys sandboxes through the client", async () => {
    const tracking = createTrackingClient();
    const provider = coreweave({ client: tracking.client });
    const sandbox = await provider.sandbox.create({});

    await sandbox.destroy();
    await provider.sandbox.destroy("sandbox-2");

    expect(tracking.deletedSandboxIds).toEqual(["sandbox-1", "sandbox-2"]);
  });

  it("fails clearly for getUrl", async () => {
    const provider = coreweave({ client: createTrackingClient().client });
    const sandbox = await provider.sandbox.create({});

    await expect(sandbox.getUrl({ port: 8080 })).rejects.toThrow(/getUrl is not implemented/);
  });
});

interface WriteRequest {
  readonly content: string;
  readonly path: string;
}

interface TrackingClient {
  readonly client: SandboxClient;
  readonly createOptions: SandboxRunOptions[];
  readonly deletedSandboxIds: string[];
  readonly execCommands: Command[];
  readonly startCommands: Command[];
  readonly writeRequests: WriteRequest[];
}

function createTrackingClient(): TrackingClient {
  const createOptions: SandboxRunOptions[] = [];
  const deletedSandboxIds: string[] = [];
  const execCommands: Command[] = [];
  const startCommands: Command[] = [];
  const writeRequests: WriteRequest[] = [];
  let sandboxCounter = 0;

  function createFakeSandbox(sandboxId: string, status: SandboxStatus = "running"): Sandbox {
    const files: SandboxFiles = {
      read: (async () => new Uint8Array()) as unknown as SandboxFiles["read"],
      readStream: () => emptyBinaryIterable(),
      readText: (async (path: string) => {
        if (path === "/workspace/app/output.txt") {
          return "file contents";
        }
        return "";
      }) as unknown as SandboxFiles["readText"],
      write: (async (path: string, content: string | Uint8Array) => {
        writeRequests.push({
          content: typeof content === "string" ? content : new TextDecoder().decode(content),
          path,
        });
      }) as unknown as SandboxFiles["write"],
      writeStream: async () => undefined,
    };

    const commands: SandboxCommands = {
      run: async (command) => {
        const normalized = normalizeCommand(command);
        execCommands.push(normalized);
        return createProcessResult(normalized, { stdout: "ok" });
      },
      start: (async (command) => {
        const normalized = normalizeCommand(command);
        startCommands.push(normalized);
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
      appliedEgressMode: undefined,
      appliedIngressMode: undefined,
      commands,
      delete: async () => {
        deletedSandboxIds.push(sandboxId);
      },
      exec: async (command) => createProcessResult(normalizeCommand(command), { stdout: "ok" }),
      exposedPorts: undefined,
      files,
      getStatus: async () => status,
      inspect: async () => ({ sandboxId, status }),
      logs,
      profileId: undefined,
      resourceLimits: undefined,
      resourceRequests: undefined,
      runnerGroupId: undefined,
      runnerId: undefined,
      sandboxId,
      serviceAddress: undefined,
      shell: async () => {
        throw new Error("Shell not used");
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
    async create(options = {}) {
      sandboxCounter++;
      createOptions.push(options);
      return createFakeSandbox(`sandbox-${sandboxCounter}`);
    },
    async run(_, options = {}) {
      sandboxCounter++;
      createOptions.push(options);
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
    async listAll() {
      return [createFakeSandbox("sandbox-listed")];
    },
    async delete(sandboxId) {
      deletedSandboxIds.push(sandboxId);
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
