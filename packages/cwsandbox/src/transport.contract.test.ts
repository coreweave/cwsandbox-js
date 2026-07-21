// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { SandboxClient } from "./client.js";
import type {
  DeleteSandboxRequest,
  ExecRequest,
  GetSandboxRequest,
  ListSandboxesOptions,
  LogEntryStream,
  LogRawStream,
  LogStream,
  ProcessResult,
  ReadFileRequest,
  StartCommandRequest,
  StartShellRequest,
  StartSandboxRequest,
  StopSandboxRequest,
  StreamLogsRequest,
  WriteFileRequest,
} from "./index.js";
import {
  createCommandProcess,
  createLogStream,
  createProcessResult,
  createTerminalSession,
} from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";

interface TransportCalls {
  readonly delete: DeleteSandboxRequest[];
  readonly exec: ExecRequest[];
  readonly get: GetSandboxRequest[];
  readonly list: ListSandboxesOptions[];
  readonly readFile: ReadFileRequest[];
  readonly start: StartSandboxRequest[];
  readonly startCommand: StartCommandRequest[];
  readonly startShell: StartShellRequest[];
  readonly stop: StopSandboxRequest[];
  readonly streamLogs: StreamLogsRequest[];
  readonly writeFile: WriteFileRequest[];
}

describe("SandboxTransport contract", () => {
  it("normalizes client requests before calling the transport", async () => {
    const { calls, transport } = createContractTransport();
    const client = new SandboxClient({ transport });

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

  it("attaches sandbox ids and normalized payloads for sandbox operations", async () => {
    const { calls, transport } = createContractTransport();
    const client = new SandboxClient({ transport });
    const sandbox = await client.run(["python"], { waitUntilRunning: false });

    await sandbox.exec(["pwd"], { cwd: "/tmp", timeoutMs: 100 });
    await sandbox.commands.start(["cat"], { stdin: true, timeoutMs: 200 });
    await sandbox.shell({ cols: 80, command: ["/bin/sh"], rows: 24, timeoutMs: 250 });
    await sandbox.files.write("/tmp/hello.txt", "hello", { timeoutMs: 300 });
    await sandbox.files.read("/tmp/hello.txt", { timeoutMs: 400 });
    await sandbox.logs.stream({ follow: true, timeoutMs: 500 });
    await sandbox.stop({ gracefulShutdownSeconds: 1, timeoutMs: 600 });
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
    expect(expectSingle(calls.writeFile)).toMatchObject({
      path: "/tmp/hello.txt",
      sandboxId: expectedSandboxId,
      timeoutMs: 300,
    });
    expect(new TextDecoder().decode(expectSingle(calls.writeFile).content)).toBe("hello");
    expect(expectSingle(calls.readFile)).toMatchObject({
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
      timeoutMs: 600,
    });
    expect(calls.delete.at(-1)).toMatchObject({
      sandboxId: expectedSandboxId,
      timeoutMs: 700,
    });
  });
});

function createContractTransport(): {
  readonly calls: TransportCalls;
  readonly transport: SandboxTransport;
} {
  const calls: TransportCalls = {
    delete: [],
    exec: [],
    get: [],
    list: [],
    readFile: [],
    start: [],
    startCommand: [],
    startShell: [],
    stop: [],
    streamLogs: [],
    writeFile: [],
  };

  return {
    calls,
    transport: {
      async delete(request) {
        calls.delete.push(request);
      },
      async exec(request): Promise<ProcessResult> {
        calls.exec.push(request);
        return createProcessResult(request.command);
      },
      async get(request) {
        calls.get.push(request);
        return {
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
      async list(options) {
        calls.list.push(options);
        return {
          sandboxes: [],
        };
      },
      async readFile(request) {
        calls.readFile.push(request);
        return {
          content: new Uint8Array(),
        };
      },
      async start(request) {
        calls.start.push(request);
        return {
          sandboxId: `sandbox-for-${request.command[0]}`,
          status: "running",
        };
      },
      async startCommand(request) {
        calls.startCommand.push(request);
        return request.stdin === true
          ? createCommandProcess(request.command, true)
          : createCommandProcess(request.command);
      },
      async startShell(request) {
        calls.startShell.push(request);
        return createTerminalSession(request.command);
      },
      async stop(request) {
        calls.stop.push(request);
      },
      async streamLogs(request): Promise<LogEntryStream | LogRawStream | LogStream> {
        calls.streamLogs.push(request);
        return createLogStream(request.mode);
      },
      async writeFile(request) {
        calls.writeFile.push(request);
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
