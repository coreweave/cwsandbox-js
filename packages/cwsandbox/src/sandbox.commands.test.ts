// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxExecutionError, CWSandboxValidationError } from "./index.js";
import {
  createClient,
  createCommandProcess,
  createFakeTransport,
  createProcessResult,
} from "./test/helpers.js";
import type { SandboxTransport } from "./transport.js";

describe("Sandbox commands", () => {
  it("runs commands through the commands namespace", async () => {
    const client = createClient();
    const sandbox = await client.run(["echo", "hello"]);
    const command: string[] = ["node", "--version"];

    const result = await sandbox.commands.run(command);

    expect(result).toMatchObject({
      command: ["node", "--version"],
      exitCode: 0,
      failed: false,
      ok: true,
      stderr: "",
      stdout: "node --version",
    });
  });

  it("forwards commands namespace options to the transport", async () => {
    let execRequest: Parameters<SandboxTransport["exec"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async exec(request) {
        execRequest = request;
        return createProcessResult(request.command);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.commands.run(["node", "--version"], {
      check: true,
      cwd: "/workspace",
      timeoutMs: 5000,
    });

    expect(execRequest).toEqual({
      command: ["node", "--version"],
      cwd: "/workspace",
      sandboxId: "sandbox-for-echo",
      timeoutMs: 5000,
    });
  });

  it("throws execution errors for checked non-zero command exits", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async exec(request) {
        return createProcessResult(request.command, {
          exitCode: 7,
          stderr: "failed",
        });
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await expect(sandbox.commands.run(["python"], { check: true })).rejects.toMatchObject({
      name: "CWSandboxExecutionError",
      result: {
        command: ["python"],
        exitCode: 7,
        failed: true,
        ok: false,
        stderr: "failed",
      },
    });
    await expect(sandbox.exec(["python"], { check: true })).rejects.toBeInstanceOf(
      CWSandboxExecutionError,
    );
    await expect(sandbox.commands.run(["python"])).resolves.toMatchObject({
      exitCode: 7,
      failed: true,
      ok: false,
    });
  });

  it("starts streaming commands through the commands namespace", async () => {
    const sandbox = await createClient().run(["echo", "hello"]);

    const process = await sandbox.commands.start(["python", "-c", "print('hello')"]);

    await expect(collect(process.stdout)).resolves.toEqual(["python -c print('hello')"]);
    await expect(process.wait()).resolves.toMatchObject({
      command: ["python", "-c", "print('hello')"],
      exitCode: 0,
      failed: false,
      ok: true,
      stderr: "",
      stdout: "python -c print('hello')",
    });
  });

  it("forwards streaming command options to the transport", async () => {
    let startCommandRequest: Parameters<SandboxTransport["startCommand"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      startCommand: ((request) => {
        startCommandRequest = request;
        return Promise.resolve(createCommandProcess(request.command));
      }) as SandboxTransport["startCommand"],
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.commands.start(["node", "--version"], {
      cwd: "/workspace",
      timeoutMs: 5000,
    });

    expect(startCommandRequest).toEqual({
      command: ["node", "--version"],
      cwd: "/workspace",
      sandboxId: "sandbox-for-echo",
      timeoutMs: 5000,
    });
  });

  it("starts streaming commands with stdin enabled", async () => {
    let startCommandRequest: Parameters<SandboxTransport["startCommand"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      startCommand: ((request) => {
        startCommandRequest = request;
        return Promise.resolve(createCommandProcess(request.command, true));
      }) as SandboxTransport["startCommand"],
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    const process = await sandbox.commands.start(["cat"], { stdin: true });

    expect(process.stdin.closed).toBe(false);
    expect(startCommandRequest).toEqual({
      command: ["cat"],
      sandboxId: "sandbox-for-echo",
      stdin: true,
    });
  });

  it("executes commands through the configured transport", async () => {
    const client = createClient();
    const sandbox = await client.run(["echo", "hello"]);
    const command: string[] = ["node", "--version"];

    const result = await sandbox.exec(command);

    expect(result).toMatchObject({
      command: ["node", "--version"],
      exitCode: 0,
      failed: false,
      ok: true,
      stderr: "",
      stdout: "node --version",
    });
  });

  it("forwards exec options to the transport", async () => {
    const signal = new AbortController().signal;
    let execRequest: Parameters<SandboxTransport["exec"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async exec(request) {
        execRequest = request;
        return createProcessResult(request.command);
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"]);

    await sandbox.exec(["node", "--version"], {
      signal,
      timeoutMs: 5000,
    });

    expect(execRequest).toEqual({
      command: ["node", "--version"],
      sandboxId: "sandbox-for-echo",
      signal,
      timeoutMs: 5000,
    });
  });

  it("throws typed validation errors for invalid command inputs and options", async () => {
    const client = createClient();
    const sandbox = await client.run(["echo", "hello"]);

    await expect(sandbox.exec([])).rejects.toThrow(CWSandboxValidationError);
    await expect(sandbox.commands.run([])).rejects.toThrow(CWSandboxValidationError);
    await expect(sandbox.exec(["echo"], { timeoutMs: -1 })).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(sandbox.exec(["echo"], { check: "yes" as unknown as boolean })).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(sandbox.commands.start(["echo"], { bufferedMaxKiB: -1 })).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(sandbox.commands.start(["echo"], { bufferedMaxKiB: 1.5 })).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(sandbox.exec(["echo"], { cwd: "" })).rejects.toThrow(CWSandboxValidationError);
    await expect(sandbox.commands.start(["echo"], { cwd: "   " })).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(
      sandbox.commands.start(["echo"], { stdin: "yes" as unknown as boolean }),
    ).rejects.toThrow(CWSandboxValidationError);
    await expect(
      sandbox.commands.start(["echo"], { check: "yes" as unknown as boolean }),
    ).rejects.toThrow(CWSandboxValidationError);
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of stream) {
    values.push(value);
  }

  return values;
}
