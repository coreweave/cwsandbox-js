// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxNotFoundError,
  SandboxClient,
  type Command,
  type CommandInputData,
  type CommandInputWriter,
  type CommandProcessWithStdin,
  type ProcessResult,
  type SandboxTransport,
  type StartSandboxRequest,
  type WriteFileRequest,
} from "@coreweave/cwsandbox";
import { UnsupportedCapabilityError } from "@tanstack/ai-sandbox";
import { describe, expect, it } from "vitest";

import { cwsandboxTanStackProvider } from "./index.js";

const encoder = new TextEncoder();

describe("cwsandboxTanStackProvider", () => {
  it("creates TanStack sandbox handles backed by SandboxClient", async () => {
    const tracking = createTrackingTransport();
    const provider = cwsandboxTanStackProvider({
      client: new SandboxClient({ transport: tracking.transport }),
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
    expect(tracking.startRequests[0]?.environmentVariables).toEqual({ API_TOKEN: "secret" });
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
      content: encoder.encode("hello"),
      path: "/workspace/app/input.txt",
      sandboxId: "sandbox-1",
    });
  });

  it("resumes existing sandboxes and returns null for missing sandboxes", async () => {
    const provider = cwsandboxTanStackProvider({
      client: new SandboxClient({ transport: createTrackingTransport().transport }),
    });

    await expect(provider.resume({ id: "sandbox-1" })).resolves.toMatchObject({
      id: "sandbox-1",
    });
    await expect(provider.resume({ id: "missing" })).resolves.toBeNull();
  });

  it("destroys sandboxes through the client", async () => {
    const tracking = createTrackingTransport();
    const provider = cwsandboxTanStackProvider({
      client: new SandboxClient({ transport: tracking.transport }),
    });
    const handle = await provider.create({});

    await handle.destroy();
    await provider.destroy({ id: "sandbox-2" });

    expect(tracking.deletedSandboxIds).toEqual(["sandbox-1", "sandbox-2"]);
  });

  it("fails clearly for unsupported capabilities", async () => {
    const provider = cwsandboxTanStackProvider({
      client: new SandboxClient({ transport: createTrackingTransport().transport }),
    });
    const handle = await provider.create({});

    expect(() => handle.ports.connect(8000)).toThrow(UnsupportedCapabilityError);
    await expect(handle.snapshot?.("test")).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});

interface TrackingTransport {
  readonly deletedSandboxIds: string[];
  readonly execCommands: Command[];
  readonly execOptions: Array<{ readonly cwd?: string }>;
  readonly startRequests: StartSandboxRequest[];
  readonly transport: SandboxTransport;
  readonly writeRequests: WriteFileRequest[];
}

function createTrackingTransport(): TrackingTransport {
  const deletedSandboxIds: string[] = [];
  const execCommands: Command[] = [];
  const execOptions: Array<{ readonly cwd?: string }> = [];
  const startRequests: StartSandboxRequest[] = [];
  const writeRequests: WriteFileRequest[] = [];

  return {
    deletedSandboxIds,
    execCommands,
    execOptions,
    startRequests,
    transport: {
      async delete(request) {
        deletedSandboxIds.push(request.sandboxId);
      },
      async exec(request) {
        execCommands.push(request.command);
        execOptions.push(request.cwd === undefined ? {} : { cwd: request.cwd });
        return createProcessResult(request.command, { stdout: "ok" });
      },
      async get(request) {
        if (request.sandboxId === "missing") {
          throw new CWSandboxNotFoundError("Sandbox not found.");
        }
        return {
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
      async list() {
        return { sandboxes: [] };
      },
      async readFile() {
        return { content: encoder.encode("file contents") };
      },
      async start(request) {
        startRequests.push(request);
        return {
          sandboxId: "sandbox-1",
          status: "running",
        };
      },
      async startCommand(request) {
        return createCommandProcess(request.command);
      },
      async startShell() {
        throw new Error("Shell is not used in these tests.");
      },
      async stop() {},
      async streamLogs() {
        throw new Error("Logs are not used in these tests.");
      },
      async writeFile(request) {
        writeRequests.push(request);
      },
    },
    writeRequests,
  };
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
    stdoutBinary: streamBytesFrom([]),
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

async function* streamBytesFrom(values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield value;
  }
}
