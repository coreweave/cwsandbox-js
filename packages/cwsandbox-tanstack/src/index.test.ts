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
  type SandboxStatus,
} from "@coreweave/cwsandbox";
import { UnsupportedCapabilityError } from "@tanstack/ai-sandbox";
import { describe, expect, it } from "vitest";

import { cwsandboxTanStackProvider } from "./index.js";

const encoder = new TextEncoder();

describe("cwsandboxTanStackProvider", () => {
  it("creates TanStack sandbox handles backed by SandboxClient", async () => {
    const tracking = createTrackingClient();
    const provider = cwsandboxTanStackProvider({
      client: tracking.client,
    });

    const handle = await provider.create({ env: { API_TOKEN: "secret" } });
    await handle.env.set({ FROM_HANDLE: "yes" });
    const result = await handle.process.exec("printf ok", {
      cwd: "/workspace/app",
      env: { FROM_PROCESS: "yes" },
    });
    await handle.fs.write("/workspace/app/input.txt", "hello");
    const text = await handle.fs.read("/workspace/app/output.txt");

    expect(provider.name).toBe("cwsandbox");
    expect(provider.capabilities()).toMatchObject({
      exec: true,
      fs: true,
      ports: false,
      snapshots: false,
    });
    expect(handle.id).toBe("sandbox-1");
    expect(handle.provider).toBe("cwsandbox");
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "ok",
    });
    expect(text).toBe("file contents");
    expect(tracking.startOptions[0]?.environmentVariables).toEqual({ API_TOKEN: "secret" });
    expect(tracking.execCommands[0]).toEqual([
      "/usr/bin/env",
      "FROM_HANDLE=yes",
      "FROM_PROCESS=yes",
      "/bin/sh",
      "-lc",
      "printf ok",
    ]);
    expect(tracking.execOptions[0]?.cwd).toBe("/workspace/app");
    expect(tracking.writeRequests[0]).toEqual({
      path: "/workspace/app/input.txt",
      content: encoder.encode("hello"),
    });
  });

  it("resumes existing sandboxes and returns null for missing sandboxes", async () => {
    const provider = cwsandboxTanStackProvider({
      client: createTrackingClient().client,
    });

    await expect(provider.resume({ id: "sandbox-1" })).resolves.toMatchObject({
      id: "sandbox-1",
    });
    await expect(provider.resume({ id: "missing" })).resolves.toBeNull();
  });

  it("destroys sandboxes through the client", async () => {
    const tracking = createTrackingClient();
    const provider = cwsandboxTanStackProvider({
      client: tracking.client,
    });
    const handle = await provider.create({});

    await handle.destroy();
    await provider.destroy({ id: "sandbox-2" });

    expect(tracking.deletedSandboxIds).toEqual(["sandbox-1", "sandbox-2"]);
  });

  it("fails clearly for unsupported capabilities", async () => {
    const provider = cwsandboxTanStackProvider({
      client: createTrackingClient().client,
    });
    const handle = await provider.create({});

    expect(() => handle.ports.connect(8000)).toThrow(UnsupportedCapabilityError);
    await expect(handle.snapshot?.("test")).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});

interface WriteRequest {
  readonly content: Uint8Array;
  readonly path: string;
}

interface TrackingClient {
  readonly client: SandboxClient;
  readonly deletedSandboxIds: string[];
  readonly execCommands: Command[];
  readonly execOptions: Array<{ readonly cwd?: string }>;
  readonly startOptions: Array<{
    readonly environmentVariables?: Readonly<Record<string, string>>;
  }>;
  readonly writeRequests: WriteRequest[];
}

function createTrackingClient(): TrackingClient {
  const deletedSandboxIds: string[] = [];
  const execCommands: Command[] = [];
  const execOptions: Array<{ readonly cwd?: string }> = [];
  const startOptions: Array<{ readonly environmentVariables?: Readonly<Record<string, string>> }> =
    [];
  const writeRequests: WriteRequest[] = [];

  let sandboxCounter = 0;

  function createFakeSandbox(sandboxId: string, status: SandboxStatus = "running"): Sandbox {
    const files: SandboxFiles = {
      read: (async (path: string) => {
        if (path === "/workspace/app/output.txt") {
          return encoder.encode("file contents");
        }
        return new Uint8Array();
      }) as SandboxFiles["read"],
      readStream: () => emptyBinaryIterable(),
      readText: (async (path: string) => {
        if (path === "/workspace/app/output.txt") {
          return "file contents";
        }
        return "";
      }) as SandboxFiles["readText"],
      write: (async (path: string, content: string | Uint8Array) => {
        writeRequests.push({
          content: typeof content === "string" ? encoder.encode(content) : content,
          path,
        });
      }) as SandboxFiles["write"],
      writeStream: async () => undefined,
    };

    const commands: SandboxCommands = {
      run: async (command, options = {}) => {
        const normalized = normalizeCommand(command);
        execCommands.push(normalized);
        execOptions.push(options.cwd === undefined ? {} : { cwd: options.cwd });
        return createProcessResult(normalized, { stdout: "ok" });
      },
      start: (async (command) =>
        createCommandProcess(normalizeCommand(command))) as SandboxCommands["start"],
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
      exec: async (command, options = {}) => {
        const normalized = normalizeCommand(command);
        execCommands.push(normalized);
        execOptions.push(options.cwd === undefined ? {} : { cwd: options.cwd });
        return createProcessResult(normalized, { stdout: "ok" });
      },
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
      startedAt: undefined,
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
    async create(options) {
      sandboxCounter++;
      const envVarsCreate = options?.environmentVariables;
      startOptions.push(envVarsCreate !== undefined ? { environmentVariables: envVarsCreate } : {});
      return createFakeSandbox(`sandbox-${sandboxCounter}`);
    },
    async run(_, options) {
      sandboxCounter++;
      const envVarsRun = options?.environmentVariables;
      startOptions.push(envVarsRun !== undefined ? { environmentVariables: envVarsRun } : {});
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
      return [];
    },
    async delete(sandboxId) {
      deletedSandboxIds.push(sandboxId);
    },
    async withSandbox(_commandOrCallback, _callbackOrOptions) {
      throw new Error("withSandbox not used in these tests.");
    },
  };

  return {
    client,
    deletedSandboxIds,
    execCommands,
    execOptions,
    startOptions,
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

function createCommandProcess(command: Command): CommandProcessWithStdin {
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
    stdout: streamFrom(["ok"]),
    async wait() {
      return createProcessResult(command, { stdout: "ok" });
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
