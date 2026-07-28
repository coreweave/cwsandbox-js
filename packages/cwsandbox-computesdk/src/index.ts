// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * CoreWeave Sandbox provider for ComputeSDK.
 *
 * Thin adapter over `@coreweave/cwsandbox` implementing ComputeSDK's
 * `defineProvider` contract.
 */

import {
  defineProvider,
  type CommandResult,
  type CreateSandboxOptions,
  type FileEntry,
  type RunCommandOptions,
  type SandboxInfo,
} from "@computesdk/provider";
import {
  CWSandboxNotFoundError,
  type Sandbox,
  type SandboxClient,
  type SandboxRunOptions,
  type SandboxStatus,
} from "@coreweave/cwsandbox";
import { createSandboxClient } from "@coreweave/cwsandbox/node";

const PROVIDER_NAME = "coreweave";
const DEFAULT_IMAGE = "ubuntu:24.04";
const DEFAULT_CPU = "2";
const DEFAULT_MEMORY = "4Gi";
const DEFAULT_MAX_LIFETIME_SECONDS = 3600;
/** Prefer streamed exec when the caller asks for a timeout above this. */
const STREAM_TIMEOUT_MS = 240_000;

export interface CoreWeaveConfig {
  /** API key; falls back to `CWSANDBOX_API_KEY`. Ignored when `client` is set. */
  readonly apiKey?: string;
  /** Gateway base URL; falls back to `CWSANDBOX_BASE_URL`, then prod. */
  readonly baseUrl?: string;
  /** Default container image for new sandboxes. */
  readonly image?: string;
  /** Default CPU (Kubernetes quantity, e.g. `"8"`). */
  readonly cpu?: string;
  /** Default memory (Kubernetes quantity, e.g. `"16Gi"`). */
  readonly memory?: string;
  /** Default max sandbox lifetime in seconds (server-enforced). */
  readonly maxLifetimeSeconds?: number;
  /** Restrict scheduling to these runner names. */
  readonly runnerIds?: readonly string[];
  /** Restrict scheduling to these profile names. */
  readonly profileNames?: readonly string[];
  /** Injected client (tests / advanced). */
  readonly client?: SandboxClient;
  /** Factory for an injected client. */
  readonly createClient?: () => Promise<SandboxClient> | SandboxClient;
}

type CoreWeaveCreateOptions = CreateSandboxOptions & {
  readonly image?: string;
  readonly maxLifetimeSeconds?: number;
  readonly runnerIds?: readonly string[];
  readonly profileNames?: readonly string[];
};

export interface CoreWeaveSandbox {
  readonly sandboxId: string;
  readonly client: SandboxClient;
  readonly sandbox: Sandbox;
  readonly createdAt: Date;
  readonly timeoutMs: number;
}

async function resolveClient(config: CoreWeaveConfig): Promise<SandboxClient> {
  if (config.client !== undefined) {
    return config.client;
  }
  if (config.createClient !== undefined) {
    return config.createClient();
  }

  const env = typeof process !== "undefined" ? process.env : {};
  const apiKey = (config.apiKey ?? env["CWSANDBOX_API_KEY"] ?? "").trim();
  if (apiKey === "") {
    throw new Error(
      "Missing CoreWeave Sandbox API key. Provide 'apiKey' in config, set CWSANDBOX_API_KEY, or inject 'client'.",
    );
  }
  const baseUrl = (config.baseUrl ?? env["CWSANDBOX_BASE_URL"])?.trim();
  return createSandboxClient({
    apiKey,
    ...(baseUrl !== undefined && baseUrl !== "" ? { baseUrl } : {}),
  });
}

function shq(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function buildShellScript(command: string, options?: RunCommandOptions): string {
  const lines: string[] = [];
  if (options?.env !== undefined) {
    for (const [key, value] of Object.entries(options.env)) {
      lines.push(`export ${key}=${shq(value)}`);
    }
  }
  if (options?.cwd !== undefined) {
    lines.push(`cd ${shq(options.cwd)}`);
  }
  lines.push(command);
  return lines.join("\n");
}

function shellArgv(script: string): readonly [string, string, string] {
  return ["/bin/bash", "-c", script];
}

function mapStatus(status: SandboxStatus | undefined): SandboxInfo["status"] {
  if (status === "running") {
    return "running";
  }
  if (status === "failed") {
    return "error";
  }
  return "stopped";
}

function toSandboxInfo(handle: CoreWeaveSandbox, sandbox: Sandbox): SandboxInfo {
  return {
    id: handle.sandboxId,
    provider: PROVIDER_NAME,
    status: mapStatus(sandbox.status),
    createdAt: sandbox.startedAt ?? handle.createdAt,
    timeout: handle.timeoutMs,
    metadata: {
      runnerId: sandbox.runnerId,
      profileId: sandbox.profileId,
      appliedEgressMode: sandbox.appliedEgressMode,
    },
  };
}

function toCreateOptions(
  config: CoreWeaveConfig,
  options?: CoreWeaveCreateOptions,
): SandboxRunOptions {
  const cpu = options?.cpu !== undefined ? String(options.cpu) : (config.cpu ?? DEFAULT_CPU);
  const memory =
    options?.memoryMiB !== undefined ? `${options.memoryMiB}Mi` : (config.memory ?? DEFAULT_MEMORY);
  const maxLifetimeSeconds =
    options?.maxLifetimeSeconds ?? config.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;
  const runnerIds = options?.runnerIds ?? config.runnerIds;
  const profileNames = options?.profileNames ?? config.profileNames;
  const tags = ["computesdk", ...(options?.name !== undefined ? [options.name] : [])];

  return {
    containerImage: options?.image ?? config.image ?? DEFAULT_IMAGE,
    maxLifetimeSeconds,
    resources: { cpu, memory },
    tags,
    waitUntilRunning: true,
    ...(options?.envs !== undefined ? { environmentVariables: options.envs } : {}),
    ...(options?.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    ...(runnerIds !== undefined && runnerIds.length > 0 ? { runnerIds } : {}),
    ...(profileNames !== undefined && profileNames.length > 0 ? { profileNames } : {}),
  };
}

function toHandle(client: SandboxClient, sandbox: Sandbox, timeoutMs: number): CoreWeaveSandbox {
  return {
    sandboxId: sandbox.sandboxId,
    client,
    sandbox,
    createdAt: sandbox.startedAt ?? new Date(),
    timeoutMs,
  };
}

async function drainStream(
  stream: AsyncIterable<string>,
  onChunk?: (data: string) => void,
): Promise<string> {
  let out = "";
  for await (const chunk of stream) {
    out += chunk;
    onChunk?.(chunk);
  }
  return out;
}

async function runStreaming(
  handle: CoreWeaveSandbox,
  script: string,
  options?: RunCommandOptions,
): Promise<CommandResult> {
  const started = Date.now();
  const startOptions = options?.timeout !== undefined ? { timeoutMs: options.timeout } : {};
  const process = await handle.sandbox.commands.start(shellArgv(script), startOptions);

  const [stdout, stderr, result] = await Promise.all([
    drainStream(process.stdout, options?.onStdout),
    drainStream(process.stderr, options?.onStderr),
    process.wait(),
  ]);

  return {
    stdout: stdout || result.stdout,
    stderr: stderr || result.stderr,
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
  };
}

async function runCommandImpl(
  handle: CoreWeaveSandbox,
  command: string,
  options?: RunCommandOptions,
): Promise<CommandResult> {
  const script = buildShellScript(command, options);
  const timeoutMs = options?.timeout;
  const wantsStreaming =
    (timeoutMs !== undefined && timeoutMs > STREAM_TIMEOUT_MS) ||
    options?.onStdout !== undefined ||
    options?.onStderr !== undefined;

  if (wantsStreaming) {
    return runStreaming(handle, script, options);
  }

  const started = Date.now();
  const runOptions = timeoutMs !== undefined ? { timeoutMs } : {};
  const result = await handle.sandbox.commands.run(shellArgv(script), runOptions);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
  };
}

async function createSandbox(
  config: CoreWeaveConfig,
  options?: CoreWeaveCreateOptions,
): Promise<{ sandbox: CoreWeaveSandbox; sandboxId: string }> {
  const client = await resolveClient(config);
  const maxLifetimeSeconds =
    options?.maxLifetimeSeconds ?? config.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;
  const sandbox = await client.create(toCreateOptions(config, options));
  const handle = toHandle(client, sandbox, maxLifetimeSeconds * 1000);
  return { sandbox: handle, sandboxId: handle.sandboxId };
}

export const coreweave = defineProvider<CoreWeaveSandbox, CoreWeaveConfig>({
  name: PROVIDER_NAME,
  methods: {
    sandbox: {
      create: createSandbox,

      getById: async (config, sandboxId) => {
        const client = await resolveClient(config);
        try {
          const sandbox = await client.fromId(sandboxId);
          return {
            sandbox: toHandle(client, sandbox, DEFAULT_MAX_LIFETIME_SECONDS * 1000),
            sandboxId,
          };
        } catch (error) {
          if (error instanceof CWSandboxNotFoundError) {
            return null;
          }
          throw error;
        }
      },

      list: async (config) => {
        const client = await resolveClient(config);
        const sandboxes = await client.listAll();
        return sandboxes.map((sandbox) => ({
          sandbox: toHandle(client, sandbox, DEFAULT_MAX_LIFETIME_SECONDS * 1000),
          sandboxId: sandbox.sandboxId,
        }));
      },

      destroy: async (config, sandboxId) => {
        const client = await resolveClient(config);
        await client.delete(sandboxId, { missingOk: true });
      },

      runCommand: runCommandImpl,

      getInfo: async (handle) => {
        try {
          const inspected = await handle.sandbox.inspect();
          return {
            id: handle.sandboxId,
            provider: PROVIDER_NAME,
            status: mapStatus(inspected.status),
            createdAt: inspected.startedAt ?? handle.createdAt,
            timeout: handle.timeoutMs,
            metadata: {
              runnerId: inspected.runnerId,
              profileId: inspected.profileId,
              appliedEgressMode: inspected.appliedEgressMode,
            },
          };
        } catch {
          return toSandboxInfo(handle, handle.sandbox);
        }
      },

      getUrl: async (_sandbox, _options) => {
        throw new Error(
          "coreweave: getUrl is not implemented yet — expose ports at create time and use the service address.",
        );
      },

      filesystem: {
        readFile: async (handle, path) => handle.sandbox.files.readText(path),

        writeFile: async (handle, path, content) => {
          await handle.sandbox.files.write(path, content);
        },

        mkdir: async (handle, path, runCommand) => {
          const result = await runCommand(handle, `mkdir -p ${shq(path)}`);
          if (result.exitCode !== 0) {
            throw new Error(`mkdir ${path} failed: ${result.stderr}`);
          }
        },

        readdir: async (handle, path, runCommand) => {
          const result = await runCommand(
            handle,
            `find ${shq(path)} -maxdepth 1 -mindepth 1 -printf '%y\\t%f\\t%s\\n'`,
          );
          if (result.exitCode !== 0) {
            throw new Error(`readdir ${path} failed: ${result.stderr}`);
          }
          const entries: FileEntry[] = [];
          for (const line of result.stdout.split("\n")) {
            if (!line.trim()) {
              continue;
            }
            const [type, name, size] = line.split("\t");
            if (name === undefined || type === undefined) {
              continue;
            }
            entries.push({
              name,
              type: type === "d" ? "directory" : "file",
              ...(size !== undefined && size !== "" ? { size: Number.parseInt(size, 10) } : {}),
            });
          }
          return entries;
        },

        exists: async (handle, path, runCommand) => {
          const result = await runCommand(handle, `test -e ${shq(path)}`);
          return result.exitCode === 0;
        },

        remove: async (handle, path, runCommand) => {
          const result = await runCommand(handle, `rm -rf ${shq(path)}`);
          if (result.exitCode !== 0) {
            throw new Error(`remove ${path} failed: ${result.stderr}`);
          }
        },
      },
    },
  },
});

export default coreweave;
