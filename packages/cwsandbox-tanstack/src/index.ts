// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxNotFoundError,
  type CommandProcessWithStdin,
  type Sandbox,
  type SandboxClient,
  type SandboxRunOptions,
} from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import {
  createExecBackedGit,
  UnsupportedCapabilityError,
  type ExecResult,
  type ProcessOptions,
  type SandboxCapabilities,
  type SandboxCreateInput,
  type SandboxDestroyInput,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxResumeInput,
  type SnapshotRef,
  type SpawnHandle,
} from "@tanstack/ai-sandbox";

const PROVIDER_NAME = "cwsandbox";
const WORKSPACE_ROOT = "/workspace";
const CAPS: SandboxCapabilities = {
  backgroundProcesses: true,
  durableFilesystem: false,
  env: true,
  exec: true,
  fork: false,
  fs: true,
  killableProcesses: true,
  networkPolicy: false,
  ports: false,
  snapshots: false,
  writableStdin: true,
};

export interface CWSandboxTanStackProviderOptions {
  readonly client?: SandboxClient;
  readonly createClient?: () => Promise<SandboxClient> | SandboxClient;
  readonly createOptions?: SandboxRunOptions;
  readonly providerName?: string;
  readonly workspaceRoot?: string;
}

export function cwsandboxTanStackProvider(
  options: CWSandboxTanStackProviderOptions = {},
): SandboxProvider {
  return new CWSandboxTanStackProvider(options);
}

class CWSandboxTanStackProvider implements SandboxProvider {
  public readonly name: string;
  private readonly options: CWSandboxTanStackProviderOptions;

  public constructor(options: CWSandboxTanStackProviderOptions) {
    this.options = options;
    this.name = options.providerName ?? PROVIDER_NAME;
  }

  public capabilities(): SandboxCapabilities {
    return CAPS;
  }

  public async create(input: SandboxCreateInput): Promise<SandboxHandle> {
    const client = await this.resolveClient();
    const sandbox = await client.create({
      ...this.options.createOptions,
      ...(input.env === undefined ? {} : { environmentVariables: input.env }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    return new CWSandboxTanStackHandle({
      client,
      provider: this.name,
      sandbox,
      workspaceRoot: this.options.workspaceRoot ?? WORKSPACE_ROOT,
    });
  }

  public async resume(input: SandboxResumeInput): Promise<SandboxHandle | null> {
    const client = await this.resolveClient();

    try {
      const sandbox = await client.fromId(
        input.id,
        input.signal === undefined ? {} : { signal: input.signal },
      );

      return new CWSandboxTanStackHandle({
        client,
        provider: this.name,
        sandbox,
        workspaceRoot: this.options.workspaceRoot ?? WORKSPACE_ROOT,
      });
    } catch (error) {
      if (error instanceof CWSandboxNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  public async destroy(input: SandboxDestroyInput): Promise<void> {
    const client = await this.resolveClient();
    await client.delete(input.id, input.signal === undefined ? {} : { signal: input.signal });
  }

  private async resolveClient(): Promise<SandboxClient> {
    if (this.options.client !== undefined) {
      return this.options.client;
    }
    if (this.options.createClient !== undefined) {
      return this.options.createClient();
    }
    return createSandboxClientFromEnv();
  }
}

interface CWSandboxTanStackHandleOptions {
  readonly client: SandboxClient;
  readonly provider: string;
  readonly sandbox: Sandbox;
  readonly workspaceRoot: string;
}

class CWSandboxTanStackHandle implements SandboxHandle {
  public readonly capabilities = CAPS;
  public readonly env: SandboxHandle["env"];
  public readonly fs: SandboxHandle["fs"];
  public readonly git: SandboxHandle["git"];
  public readonly id: string;
  public readonly ports: SandboxHandle["ports"];
  public readonly process: SandboxHandle["process"];
  public readonly provider: string;
  public readonly workspaceRoot: string;
  public readonly destroy: SandboxHandle["destroy"];
  private readonly client: SandboxClient;
  private readonly envVars: Record<string, string> = {};
  private readonly sandbox: Sandbox;

  public constructor(options: CWSandboxTanStackHandleOptions) {
    this.client = options.client;
    this.provider = options.provider;
    this.sandbox = options.sandbox;
    this.workspaceRoot = options.workspaceRoot;
    this.id = options.sandbox.sandboxId;
    this.process = {
      exec: (command, processOptions) => this.exec(command, processOptions),
      spawn: (command, processOptions) => this.spawn(command, processOptions),
    };
    this.fs = {
      exists: (path) => this.exists(path),
      list: (path) => this.list(path),
      mkdir: (path) => this.runFsCommand(`mkdir -p ${quote(path)}`),
      read: (path) => this.sandbox.files.readText(path),
      readBytes: (path) => this.sandbox.files.read(path),
      remove: (path) => this.runFsCommand(`rm -rf ${quote(path)}`),
      rename: (from, to) => this.runFsCommand(`mv ${quote(from)} ${quote(to)}`),
      write: (path, data) => this.sandbox.files.write(path, data),
    };
    this.git = createExecBackedGit(this.process, this.workspaceRoot);
    this.ports = {
      connect: () => {
        throw new UnsupportedCapabilityError(this.provider, "ports");
      },
    };
    this.env = {
      set: (vars) => {
        Object.assign(this.envVars, vars);
        return Promise.resolve();
      },
    };
    this.destroy = () => this.client.delete(this.id);
  }

  public async snapshot(_label?: string): Promise<SnapshotRef> {
    throw new UnsupportedCapabilityError(this.provider, "snapshot");
  }

  private async exec(command: string, options: ProcessOptions = {}): Promise<ExecResult> {
    const result = await this.sandbox.commands.run(
      shellCommand(command, this.envVars, options.env),
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );

    return {
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  private async spawn(command: string, options: ProcessOptions = {}): Promise<SpawnHandle> {
    const process = await this.sandbox.commands.start(
      shellCommand(command, this.envVars, options.env),
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        stdin: true,
      },
    );

    return toSpawnHandle(process);
  }

  private async exists(path: string): Promise<boolean> {
    const result = await this.exec(`test -e ${quote(path)}`);
    return result.exitCode === 0;
  }

  private async list(
    path: string,
  ): Promise<Array<{ name: string; path: string; type: "dir" | "file" }>> {
    const result = await this.exec(
      `find ${quote(path)} -mindepth 1 -maxdepth 1 -printf '%f\\t%p\\t%y\\n'`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`list failed: ${result.stderr.trim()}`);
    }

    return result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, entryPath, kind] = line.split("\t");
        if (name === undefined || entryPath === undefined || kind === undefined) {
          throw new Error(`Unexpected list entry: ${line}`);
        }

        return {
          name,
          path: entryPath,
          type: kind === "d" ? "dir" : "file",
        };
      });
  }

  private async runFsCommand(command: string): Promise<void> {
    const result = await this.exec(command);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Command failed: ${command}`);
    }
  }
}

function shellCommand(
  command: string,
  handleEnv: Record<string, string>,
  processEnv: Record<string, string> | undefined,
): readonly string[] {
  const env = { ...handleEnv, ...processEnv };
  if (Object.keys(env).length === 0) {
    return ["/bin/sh", "-lc", command];
  }

  return [
    "/usr/bin/env",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    "/bin/sh",
    "-lc",
    command,
  ];
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toSpawnHandle(process: CommandProcessWithStdin): SpawnHandle {
  return {
    kill: () => process.cancel(),
    pid: -1,
    stderr: process.stderr,
    stdin: {
      end: () => process.stdin.close(),
      write: (data) => process.stdin.write(data),
    },
    stdout: process.stdout,
    wait: async () => {
      const result = await process.wait();
      return result.exitCode;
    },
  };
}
