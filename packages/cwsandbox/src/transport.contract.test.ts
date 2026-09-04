// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { SandboxClient } from "./client.js";
import type {
  ListSandboxesOptions,
  LogEntryStream,
  LogRawStream,
  LogStream,
  ProcessResult,
} from "./index.js";
import {
  createCommandProcess,
  createFakeFileAdapter,
  createFakeSnapshot,
  createLogStream,
  createProcessResult,
  createTerminalSession,
} from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";
import type {
  ReadFileRequest,
  ReadFileResult,
  WriteFileRequest,
} from "./transport/file-adapter.js";
import type {
  DeleteSandboxRequest,
  ExecRequest,
  GetSandboxRequest,
  StartCommandRequest,
  StartShellRequest,
  StartSandboxFromFileRequest,
  StartSandboxFromTemplateRequest,
  StartSandboxRequest,
  StopSandboxRequest,
  StreamLogsRequest,
} from "./transport/types.js";

interface AdapterCalls {
  readonly readFile: ReadFileRequest[];
  readonly writeFile: WriteFileRequest[];
}

interface TransportCalls {
  readonly delete: DeleteSandboxRequest[];
  readonly exec: ExecRequest[];
  readonly get: GetSandboxRequest[];
  readonly list: ListSandboxesOptions[];
  readonly start: StartSandboxRequest[];
  readonly startFromFile: StartSandboxFromFileRequest[];
  readonly startFromTemplate: StartSandboxFromTemplateRequest[];
  readonly startCommand: StartCommandRequest[];
  readonly startShell: StartShellRequest[];
  readonly stop: StopSandboxRequest[];
  readonly streamLogs: StreamLogsRequest[];
}

describe("SandboxTransport contract", () => {
  it("normalizes client requests before calling the transport", async () => {
    const { calls, transport, fileAdapter } = createContractTransport();
    const client = new SandboxClient({ fileAdapter, transport });

    const sandbox = await client.run(["echo", "hello"], {
      tags: ["contract-test"],
      timeoutMs: 123,
      waitUntilRunning: false,
    });
    await client.fromId("existing-sandbox", { timeoutMs: 456 });
    await client.list({ pageSize: 5, tags: ["contract-test"] });
    await client.delete("delete-me", { timeoutMs: 789 });

    expect(expectSingle(calls.start)).toMatchObject({
      command: ["echo", "hello"],
      tags: ["contract-test"],
      timeoutMs: 123,
    });
    expect(expectSingle(calls.start)).not.toHaveProperty("waitUntilRunning");
    expect(sandbox.sandboxId).toBe("sandbox-for-echo");
    expect(expectSingle(calls.get)).toMatchObject({
      sandboxId: "existing-sandbox",
      timeoutMs: 456,
    });
    expect(expectSingle(calls.list)).toMatchObject({
      pageSize: 5,
      tags: ["contract-test"],
    });
    expect(expectSingle(calls.delete)).toMatchObject({
      sandboxId: "delete-me",
      timeoutMs: 789,
    });
  });

  it("routes runFromTemplate through startFromTemplate with a normalized command", async () => {
    const { calls, transport, fileAdapter } = createContractTransport();
    const client = new SandboxClient({ fileAdapter, transport });
    const templateId = "11111111-1111-1111-1111-111111111111";

    const sandbox = await client.runFromTemplate(templateId, {
      command: ["/bin/sh", "-c", "echo ready"],
      containerImage: "python:3.11",
      waitUntilRunning: false,
    });

    expect(calls.start).toEqual([]);
    expect(expectSingle(calls.startFromTemplate)).toMatchObject({
      command: ["/bin/sh", "-c", "echo ready"],
      containerImage: "python:3.11",
      templateId,
    });
    expect(expectSingle(calls.startFromTemplate)).not.toHaveProperty("waitUntilRunning");
    expect(sandbox.sandboxId).toBe(`sandbox-for-template-${templateId}`);
  });

  it("routes runFromFile through startFromFile with raw file bytes", async () => {
    const { calls, transport, fileAdapter } = createContractTransport();
    const client = new SandboxClient({ fileAdapter, transport });
    const contents = new TextEncoder().encode("services:\n  main:\n    image: python:3.11\n  \n");

    const sandbox = await client.runFromFile(contents, {
      imageOverrides: { api: "python:3.12" },
      primaryService: "main",
      waitUntilRunning: false,
    });

    expect(calls.start).toEqual([]);
    expect(calls.startFromTemplate).toEqual([]);
    expect(expectSingle(calls.startFromFile)).toMatchObject({
      contents,
      fileType: "compose",
      imageOverrides: { api: "python:3.12" },
      primaryService: "main",
    });
    expect(expectSingle(calls.startFromFile)).not.toHaveProperty("waitUntilRunning");
    expect(sandbox.sandboxId).toBe("sandbox-from-file");
  });

  it("attaches sandbox ids and normalized payloads for sandbox operations", async () => {
    const { calls, adapterCalls, transport, fileAdapter } = createContractTransport();
    const client = new SandboxClient({ fileAdapter, transport });
    const sandbox = await client.run(["python"], { waitUntilRunning: false });

    await sandbox.exec(["pwd"], { cwd: "/tmp", timeoutMs: 100 });
    await sandbox.commands.start(["cat"], { stdin: true, timeoutMs: 200 });
    await sandbox.shell({ cols: 80, command: ["/bin/sh"], rows: 24, timeoutMs: 250 });
    await sandbox.files.write("/tmp/hello.txt", "hello", { timeoutMs: 300 });
    await sandbox.files.read("/tmp/hello.txt", { timeoutMs: 400 });
    await sandbox.logs.stream({ follow: true, timeoutMs: 500 });
    await sandbox.stop({ gracefulShutdownSeconds: 1 });
    await sandbox.delete({ timeoutMs: 700 });

    const expectedSandboxId = "sandbox-for-python";
    expect(expectSingle(calls.exec)).toMatchObject({
      command: ["pwd"],
      cwd: "/tmp",
      sandboxId: expectedSandboxId,
      timeoutMs: 100,
    });
    expect(expectSingle(calls.startCommand)).toMatchObject({
      command: ["cat"],
      sandboxId: expectedSandboxId,
      stdin: true,
      timeoutMs: 200,
    });
    expect(expectSingle(calls.startShell)).toMatchObject({
      cols: 80,
      command: ["/bin/sh"],
      rows: 24,
      sandboxId: expectedSandboxId,
      timeoutMs: 250,
    });
    expect(expectSingle(adapterCalls.writeFile)).toMatchObject({
      path: "/tmp/hello.txt",
      sandboxId: expectedSandboxId,
      timeoutMs: 300,
    });
    expect(new TextDecoder().decode(expectSingle(adapterCalls.writeFile).content)).toBe("hello");
    expect(expectSingle(adapterCalls.readFile)).toMatchObject({
      path: "/tmp/hello.txt",
      sandboxId: expectedSandboxId,
      timeoutMs: 400,
    });
    expect(expectSingle(calls.streamLogs)).toMatchObject({
      follow: true,
      mode: "lines",
      sandboxId: expectedSandboxId,
      timeoutMs: 500,
    });
    expect(expectSingle(calls.stop)).toMatchObject({
      gracefulShutdownSeconds: 1,
      sandboxId: expectedSandboxId,
    });
    expect(calls.delete.at(-1)).toMatchObject({
      sandboxId: expectedSandboxId,
      timeoutMs: 700,
    });
  });
});

function createContractTransport(): {
  readonly adapterCalls: AdapterCalls;
  readonly calls: TransportCalls;
  readonly fileAdapter: ReturnType<typeof createFakeFileAdapter>;
  readonly transport: SandboxTransport;
} {
  const calls: TransportCalls = {
    delete: [],
    exec: [],
    get: [],
    list: [],
    start: [],
    startFromFile: [],
    startFromTemplate: [],
    startCommand: [],
    startShell: [],
    stop: [],
    streamLogs: [],
  };

  const adapterCalls: AdapterCalls = {
    readFile: [],
    writeFile: [],
  };

  let stopped = false;

  const fileAdapter = createFakeFileAdapter({
    async write(request) {
      adapterCalls.writeFile.push(request);
    },
    async read(request): Promise<ReadFileResult> {
      adapterCalls.readFile.push(request);
      return { content: new Uint8Array() };
    },
  });

  return {
    adapterCalls,
    calls,
    fileAdapter,
    transport: {
      async delete(request) {
        calls.delete.push(request);
      },
      async createFileSystemSnapshot(request) {
        return createFakeSnapshot(`snapshot-for-${request.sandboxId}`, { state: "creating" });
      },
      async deleteFileSystemSnapshot() {
        return undefined;
      },
      async exec(request): Promise<ProcessResult> {
        calls.exec.push(request);
        return createProcessResult(request.command);
      },
      async get(request) {
        calls.get.push(request);
        return {
          sandboxId: request.sandboxId,
          status: stopped ? "terminated" : "running",
        };
      },
      async getFileSystemSnapshot(request) {
        return createFakeSnapshot(request.snapshotId);
      },
      async listFileSystemSnapshots() {
        return { snapshots: [] };
      },
      async list(options) {
        calls.list.push(options);
        return {
          sandboxes: [],
        };
      },
      async start(request) {
        calls.start.push(request);
        return {
          sandboxId: `sandbox-for-${request.command[0]}`,
          status: "running",
        };
      },
      async startFromTemplate(request) {
        calls.startFromTemplate.push(request);
        return {
          sandboxId: `sandbox-for-template-${request.templateId}`,
          status: "running",
        };
      },
      async startFromFile(request) {
        calls.startFromFile.push(request);
        return {
          sandboxId: "sandbox-from-file",
          status: "running",
        };
      },
      startCommand: ((request: StartCommandRequest) => {
        calls.startCommand.push(request);
        return Promise.resolve(
          request.stdin === true
            ? createCommandProcess(request.command, true)
            : createCommandProcess(request.command),
        );
      }) as SandboxTransport["startCommand"],
      async startShell(request) {
        calls.startShell.push(request);
        return createTerminalSession(request.command);
      },
      async stop(request) {
        calls.stop.push(request);
        stopped = true;
      },
      async streamLogs(request): Promise<LogEntryStream | LogRawStream | LogStream> {
        calls.streamLogs.push(request);
        return createLogStream(request.mode);
      },
    },
  };
}

function expectSingle<T>(values: readonly T[]): T {
  expect(values).toHaveLength(1);
  const value = values[0];
  expect(value).toBeDefined();
  return value as T;
}
