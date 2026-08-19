// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * CoreWeave Sandbox provider for ComputeSDK.
 *
 * Thin adapter over `@coreweave/cwsandbox` implementing ComputeSDK's
 * `defineProvider` contract.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";

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
  type Command,
  type Sandbox,
  type SandboxClient,
  type SandboxRunOptions,
  type SandboxStatus,
} from "@coreweave/cwsandbox";
import { createSandboxClient } from "@coreweave/cwsandbox/node";

const PROVIDER_NAME = "coreweave";
const ADAPTER_TAG = "computesdk";
const DEFAULT_IMAGE = "ubuntu:24.04";
const DEFAULT_CPU = "2";
const DEFAULT_MEMORY = "4Gi";
const DEFAULT_MAX_LIFETIME_SECONDS = 3600;
/** Prefer streamed exec when the caller asks for a timeout above this. */
const STREAM_TIMEOUT_MS = 240_000;
const OWNER_TAG_PATTERN = /^[A-Za-z0-9._-]*[A-Za-z0-9]$/;
const OWNER_TAG_MAX_LENGTH = 59;
/** Hostname assignment can lag `running`; match core e2e wait. */
const SERVICE_URL_WAIT_MS = 60_000;
const SERVICE_URL_POLL_MS = 500;

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
  /**
   * Stable tag for list/destroy scoping. When omitted, a random 6-char id is
   * generated once per provider config (process-local).
   */
  readonly ownerTag?: string;
  /** Restrict scheduling to these runner names. */
  readonly runnerIds?: readonly string[];
  /** Injected client (tests / advanced). */
  readonly client?: SandboxClient;
  /** Factory for an injected client. */
  readonly createClient?: () => Promise<SandboxClient> | SandboxClient;
}

type CoreWeaveCreateOptions = CreateSandboxOptions & {
  readonly image?: string;
  readonly maxLifetimeSeconds?: number;
  readonly network?: SandboxRunOptions["network"];
  readonly runnerIds?: readonly string[];
  readonly services?: SandboxRunOptions["services"];
};

export interface CoreWeaveSandbox {
  readonly sandboxId: string;
  readonly client: SandboxClient;
  readonly sandbox: Sandbox;
  readonly createdAt: Date;
  readonly timeoutMs: number;
}

const clientCache = new WeakMap<CoreWeaveConfig, Promise<SandboxClient>>();
const ownerTagCache = new WeakMap<CoreWeaveConfig, string>();

function validateOwnerTag(tag: string): string {
  if (tag === ADAPTER_TAG) {
    throw new Error(`ownerTag must not equal the reserved adapter tag "${ADAPTER_TAG}".`);
  }
  if (tag.length === 0 || tag.length > OWNER_TAG_MAX_LENGTH || !OWNER_TAG_PATTERN.test(tag)) {
    throw new Error(
      `Invalid ownerTag "${tag}". Tags may contain letters, numbers, '.', '_' or '-', must be ${OWNER_TAG_MAX_LENGTH} characters or fewer, and must end with a letter or number.`,
    );
  }
  return tag;
}

function generateOwnerTag(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(6);
  let out = "";
  for (const byte of bytes) {
    const char = alphabet[byte % alphabet.length];
    if (char === undefined) {
      throw new Error("ownerTag alphabet lookup failed");
    }
    out += char;
  }
  return out;
}

function resolveOwnerTag(config: CoreWeaveConfig): string {
  const cached = ownerTagCache.get(config);
  if (cached !== undefined) {
    return cached;
  }
  const tag =
    config.ownerTag !== undefined ? validateOwnerTag(config.ownerTag.trim()) : generateOwnerTag();
  ownerTagCache.set(config, tag);
  return tag;
}

async function resolveClient(config: CoreWeaveConfig): Promise<SandboxClient> {
  if (config.client !== undefined) {
    return config.client;
  }

  const cached = clientCache.get(config);
  if (cached !== undefined) {
    return cached;
  }

  const pending = (async (): Promise<SandboxClient> => {
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
  })();

  clientCache.set(config, pending);
  return pending;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForAssignedUrl(handle: CoreWeaveSandbox, port: number): Promise<string> {
  const deadline = Date.now() + SERVICE_URL_WAIT_MS;

  while (Date.now() < deadline) {
    const inspected = await handle.sandbox.inspect();
    const match = inspected.serviceUrls?.find(
      (service) => service.port === port && service.url.startsWith("https://"),
    );
    if (match !== undefined) {
      return match.url;
    }
    await sleep(SERVICE_URL_POLL_MS);
  }

  throw new Error(
    `coreweave: getUrl: no assigned HTTPS URL for port ${port} after ${SERVICE_URL_WAIT_MS}ms`,
  );
}

function shq(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function shellCommand(command: string, env: Record<string, string> | undefined): Command {
  if (env === undefined || Object.keys(env).length === 0) {
    return ["/bin/sh", "-c", command];
  }

  return [
    "/usr/bin/env",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    "/bin/sh",
    "-c",
    command,
  ] as Command;
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

function resolveMaxLifetimeSeconds(
  config: CoreWeaveConfig,
  options?: CoreWeaveCreateOptions,
): number {
  if (options?.maxLifetimeSeconds !== undefined) {
    return options.maxLifetimeSeconds;
  }
  if (options?.timeout !== undefined) {
    return Math.ceil(options.timeout / 1000);
  }
  return config.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;
}

function toCreateOptions(
  config: CoreWeaveConfig,
  options: CoreWeaveCreateOptions | undefined,
  ownerTag: string,
): SandboxRunOptions {
  const cpu = options?.cpu !== undefined ? String(options.cpu) : (config.cpu ?? DEFAULT_CPU);
  const memory =
    options?.memoryMiB !== undefined ? `${options.memoryMiB}Mi` : (config.memory ?? DEFAULT_MEMORY);
  const maxLifetimeSeconds = resolveMaxLifetimeSeconds(config, options);
  const runnerIds = options?.runnerIds ?? config.runnerIds;
  const name = options?.name?.trim();

  return {
    containerImage: options?.image ?? config.image ?? DEFAULT_IMAGE,
    maxLifetimeSeconds,
    resources: { cpu, memory },
    tags: [ADAPTER_TAG, ownerTag],
    waitUntilRunning: true,
    ...(name !== undefined && name !== "" ? { annotations: { name } } : {}),
    ...(options?.envs !== undefined ? { environmentVariables: options.envs } : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    ...(runnerIds !== undefined && runnerIds.length > 0 ? { runnerIds } : {}),
    ...(options?.services !== undefined ? { services: options.services } : {}),
    ...(options?.network !== undefined ? { network: options.network } : {}),
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
  argv: Command,
  options?: RunCommandOptions,
): Promise<CommandResult> {
  const started = Date.now();
  const startOptions = {
    ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options?.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
  };
  const process = await handle.sandbox.commands.start(argv, startOptions);

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
  const argv = shellCommand(command, options?.env);
  const timeoutMs = options?.timeout;
  const wantsStreaming = timeoutMs !== undefined && timeoutMs > STREAM_TIMEOUT_MS;

  if (wantsStreaming) {
    return runStreaming(handle, argv, options);
  }

  const started = Date.now();
  const runOptions = {
    ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  const result = await handle.sandbox.commands.run(argv, runOptions);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
  };
}

function parseLsLaEntries(stdout: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("total ")) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 9) {
      continue;
    }
    const perms = parts[0];
    if (perms === undefined) {
      continue;
    }
    const name = parts.slice(8).join(" ");
    if (name === "." || name === "..") {
      continue;
    }
    const size = Number.parseInt(parts[4] ?? "", 10);
    entries.push({
      name,
      type: perms.startsWith("d") ? "directory" : "file",
      ...(Number.isFinite(size) ? { size } : {}),
    });
  }
  return entries;
}

async function createSandbox(
  config: CoreWeaveConfig,
  options?: CoreWeaveCreateOptions,
): Promise<{ sandbox: CoreWeaveSandbox; sandboxId: string }> {
  const client = await resolveClient(config);
  const ownerTag = resolveOwnerTag(config);
  const maxLifetimeSeconds = resolveMaxLifetimeSeconds(config, options);
  const sandbox = await client.create(toCreateOptions(config, options, ownerTag));
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
            sandbox: toHandle(
              client,
              sandbox,
              (config.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS) * 1000,
            ),
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
        const ownerTag = resolveOwnerTag(config);
        const sandboxes = await client.listAll({ tags: [ADAPTER_TAG, ownerTag] });
        return sandboxes.map((sandbox) => ({
          sandbox: toHandle(
            client,
            sandbox,
            (config.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS) * 1000,
          ),
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
            },
          };
        } catch (error) {
          if (error instanceof CWSandboxNotFoundError) {
            return {
              id: handle.sandboxId,
              provider: PROVIDER_NAME,
              status: "stopped",
              createdAt: handle.createdAt,
              timeout: handle.timeoutMs,
            };
          }
          throw error;
        }
      },

      getUrl: async (handle, { port }) => waitForAssignedUrl(handle, port),

      filesystem: {
        readFile: async (handle, filePath) => handle.sandbox.files.readText(filePath),

        writeFile: async (handle, filePath, content, runCommand) => {
          const parent = path.posix.dirname(filePath);
          if (parent !== "" && parent !== "." && parent !== "/") {
            const mkdirResult = await runCommand(handle, `mkdir -p ${shq(parent)}`);
            if (mkdirResult.exitCode !== 0) {
              throw new Error(`mkdir ${parent} failed: ${mkdirResult.stderr}`);
            }
          }
          await handle.sandbox.files.write(filePath, content);
        },

        mkdir: async (handle, dirPath, runCommand) => {
          const result = await runCommand(handle, `mkdir -p ${shq(dirPath)}`);
          if (result.exitCode !== 0) {
            throw new Error(`mkdir ${dirPath} failed: ${result.stderr}`);
          }
        },

        readdir: async (handle, dirPath, runCommand) => {
          const result = await runCommand(handle, `ls -la ${shq(dirPath)}`);
          if (result.exitCode !== 0) {
            throw new Error(`readdir ${dirPath} failed: ${result.stderr}`);
          }
          return parseLsLaEntries(result.stdout);
        },

        exists: async (handle, filePath, runCommand) => {
          const result = await runCommand(handle, `test -e ${shq(filePath)}`);
          return result.exitCode === 0;
        },

        remove: async (handle, filePath, runCommand) => {
          const result = await runCommand(handle, `rm -rf ${shq(filePath)}`);
          if (result.exitCode !== 0) {
            throw new Error(`remove ${filePath} failed: ${result.stderr}`);
          }
        },
      },
    },
  },
});

export default coreweave;
