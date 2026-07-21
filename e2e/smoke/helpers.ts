// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isCWSandboxError,
  type ExecOptions,
  type ProcessResult,
  type Sandbox,
  type SandboxClient,
  type SandboxRunOptions,
  type SandboxTag,
} from "@coreweave/cwsandbox";
import { expect } from "vitest";

import { resolveWandbApiKey } from "../../packages/cwsandbox/src/integrations/wandb/auth.js";

/** Just above typical unary file caps; should green after StreamExec fallback. */
export const LARGE_FILE_64_MIB = 64 * 1024 * 1024;
/** Stress size still under Python ~256 MiB auto-fallback ceiling. */
export const LARGE_FILE_200_MIB = 200 * 1024 * 1024;
export const largeFileTimeout64Ms = 300_000;
export const largeFileTimeout200Ms = 600_000;

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
export const testTimeoutMs = 120_000;

export async function expectRunning(sandbox: Sandbox): Promise<void> {
  await sandbox.wait();
  await expect(sandbox.getStatus()).resolves.toBe("running");
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

export function logProcessResult(name: string, result: ProcessResult): void {
  console.log(`${name} exit code: ${result.exitCode}`);
  console.log(`${name} stdout: ${JSON.stringify(result.stdout)}`);
  console.log(`${name} stderr: ${JSON.stringify(result.stderr)}`);
}

export function createPatternedPayload(byteLength: number): Uint8Array {
  const payload = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    payload[i] = i % 251;
  }
  return payload;
}

/** Write patterned bytes inside the sandbox without putting the payload on argv. */
export function patternedFileWriteScript(path: string, byteLength: number): string {
  return `
path = ${JSON.stringify(path)}
size = ${byteLength}
chunk = 1024 * 1024
with open(path, "wb") as f:
    written = 0
    while written < size:
        n = min(chunk, size - written)
        f.write(bytearray((written + i) % 251 for i in range(n)))
        written += n
print(written)
`.trim();
}

export function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);

  const actualBuf = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const expectedBuf = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  const comparison = Buffer.compare(actualBuf, expectedBuf);
  if (comparison === 0) {
    return;
  }

  let firstDiff = -1;
  for (let i = 0; i < actual.byteLength; i += 1) {
    if (actual[i] !== expected[i]) {
      firstDiff = i;
      break;
    }
  }

  expect.fail(
    `byte payloads differ (compare=${comparison}, firstDiff=${firstDiff}, len=${actual.byteLength})`,
  );
}

export function logCaughtError(label: string, error: unknown): void {
  if (isCWSandboxError(error)) {
    console.log(`${label} error:`, {
      code: error.code,
      message: error.message,
      name: error.name,
    });
    return;
  }

  if (error instanceof Error) {
    console.log(`${label} error:`, { message: error.message, name: error.name });
    return;
  }

  console.log(`${label} error:`, error);
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
