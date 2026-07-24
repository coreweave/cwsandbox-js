// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExecOptions,
  ProcessResult,
  Sandbox,
  SandboxClient,
  SandboxRunOptions,
  SandboxStatus,
  SandboxTag,
} from "@coreweave/cwsandbox";
import { expect } from "vitest";

import { resolveWandbApiKey } from "../../packages/cwsandbox/src/integrations/wandb/auth.js";

export interface SmokeConfig {
  readonly hasCredentials: boolean;
  readonly hasWandbCredentials: boolean;
  readonly hasWandbSecretsSmoke: boolean;
  readonly wandbSecretsSmoke:
    | {
        readonly envVar: string;
        readonly expected: string;
        readonly name: string;
        readonly store: string;
      }
    | undefined;
}

const smokeDir = dirname(fileURLToPath(import.meta.url));

export const mountedBinaryContent = new Uint8Array([0, 1, 2, 127, 128, 255]);
export const noInternetProbeScript = readSmokeScript("no-internet-probe.py");
export const portProtocols = ["TCP", "UDP", "SCTP"] as const;
export const resourceProbeScript = readSmokeScript("resource-probe.py");
export const smokeConfig = createSmokeConfig();
export const terminalStatuses = new Set<SandboxStatus>(["completed", "failed", "terminated"]);
export const testTimeoutMs = 120_000;

export async function expectRunning(sandbox: Sandbox): Promise<void> {
  await sandbox.wait();
  await expect(sandbox.getStatus()).resolves.toBe("running");
}

export async function expectTerminalStatus(sandbox: Sandbox): Promise<void> {
  const status = await sandbox.getStatus();
  expect(terminalStatuses.has(status)).toBe(true);
  expect(sandbox.status).toBe(status);
}

export async function listIncludesSandbox(
  client: SandboxClient,
  sandboxId: string,
  tags: readonly SandboxTag[] = [],
  options: { readonly pageSize?: number } = {},
): Promise<boolean> {
  let pageToken: string | undefined;

  for (let pageCount = 0; pageCount < 10; pageCount += 1) {
    const result = await client.list({
      pageSize: options.pageSize ?? 100,
      ...(pageToken === undefined ? {} : { pageToken }),
      ...(tags.length === 0 ? {} : { tags }),
    });

    if (result.sandboxes.some((sandbox) => sandbox.sandboxId === sandboxId)) {
      return true;
    }

    if (result.nextPageToken === undefined) {
      return false;
    }

    pageToken = result.nextPageToken;
  }

  return false;
}

export async function listAllIncludesSandbox(
  client: SandboxClient,
  sandboxId: string,
  tags: readonly SandboxTag[] = [],
  options: { readonly pageSize?: number } = {},
): Promise<Sandbox | undefined> {
  const sandboxes = await client.listAll({
    pageSize: options.pageSize ?? 100,
    ...(tags.length === 0 ? {} : { tags }),
  });

  return sandboxes.find((sandbox) => sandbox.sandboxId === sandboxId);
}

export function logProcessResult(name: string, result: ProcessResult): void {
  console.log(`${name} exit code: ${result.exitCode}`);
  console.log(`${name} stdout: ${JSON.stringify(result.stdout)}`);
  console.log(`${name} stderr: ${JSON.stringify(result.stderr)}`);
}

export function runPython(
  sandbox: Sandbox,
  script: string,
  options: ExecOptions = {},
): Promise<ProcessResult> {
  return sandbox.commands.run(["python", "-c", script], options);
}

export function startOptionsForInternetNetwork(): SandboxRunOptions {
  return {
    network: {
      egressMode: "internet",
    },
  };
}

export function startOptionsForNoInternetNetwork(): SandboxRunOptions {
  return {
    network: {
      egressMode: "none",
    },
  };
}

export function uniqueSmokeTag(): SandboxTag {
  return `cwsandbox-js-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 10)}x`;
}

export function withStartedSandbox<TResult>(
  client: SandboxClient,
  options: SandboxRunOptions,
  callback: (sandbox: Sandbox) => Promise<TResult> | TResult,
): Promise<TResult> {
  return client.withSandbox(callback, options);
}

export async function withDedicatedTaggedSandbox<TResult>(
  client: SandboxClient,
  options: {
    readonly create?: (tag: SandboxTag) => Promise<Sandbox>;
    readonly waitUntilRunning?: boolean;
  },
  callback: (sandbox: Sandbox) => Promise<TResult> | TResult,
): Promise<TResult> {
  const create = options.create ?? ((tag) => client.create({ tags: [tag] }));
  const sandbox = await create(uniqueSmokeTag());

  try {
    if (options.waitUntilRunning) {
      await sandbox.wait();
      expect(await sandbox.getStatus()).toBe("running");
    }

    return await callback(sandbox);
  } finally {
    await sandbox.delete().catch(() => undefined);
  }
}

function createSmokeConfig(): SmokeConfig {
  const wandbSecretsSmoke = readWandbSecretsSmokeConfig();
  return {
    hasCredentials: Boolean(process.env["CWSANDBOX_API_KEY"]?.trim()),
    hasWandbCredentials: hasWandbCredentials(),
    hasWandbSecretsSmoke: hasWandbCredentials() && wandbSecretsSmoke !== undefined,
    wandbSecretsSmoke,
  };
}

function readWandbSecretsSmokeConfig(): SmokeConfig["wandbSecretsSmoke"] {
  const name = process.env["CWSANDBOX_SMOKE_SECRET_NAME"]?.trim();
  const expected = process.env["CWSANDBOX_SMOKE_SECRET_EXPECTED"]?.trim();
  if (name === undefined || name === "" || expected === undefined || expected === "") {
    return undefined;
  }

  const store = process.env["CWSANDBOX_SMOKE_SECRET_STORE"]?.trim() || "wandb-team-secrets";
  const envVar = process.env["CWSANDBOX_SMOKE_SECRET_ENV_VAR"]?.trim() || name;

  return { envVar, expected, name, store };
}

function hasWandbCredentials(): boolean {
  try {
    resolveWandbApiKey();
    return true;
  } catch {
    return false;
  }
}

function readSmokeScript(filename: string): string {
  return readFileSync(join(smokeDir, "..", "scripts", filename), "utf8");
}
