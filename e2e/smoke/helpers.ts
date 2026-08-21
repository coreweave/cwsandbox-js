// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CWSandboxTransportError,
  CWSandboxValidationError,
  type CommandInput,
  type ExecOptions,
  type ProcessResult,
  type Sandbox,
  type SandboxClient,
  type SandboxExposedPort,
  type SandboxRunOptions,
  type SandboxStatus,
  type SandboxTag,
  type Service,
  type ServiceUrl,
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
export const dualHttpServerScript = readSmokeScript("dual-http-server.js");
export const noInternetProbeScript = readSmokeScript("no-internet-probe.py");
export const portProtocols = ["TCP", "UDP", "SCTP"] as const;
export const resourceProbeScript = readSmokeScript("resource-probe.py");
export const smokeConfig = createSmokeConfig();
export const terminalStatuses = new Set<SandboxStatus>(["completed", "failed", "terminated"]);
export const testTimeoutMs = 120_000;
export const serviceUrlWaitTimeoutMs = 60_000;
export const websocketEchoScript = readSmokeScript("websocket-echo.js");

/** Known-good large unary size (matches Python integration; below 32 MiB cap). */
export const LARGE_FILE_20_MIB = 20 * 1024 * 1024;
export const largeFileTimeout20Ms = 180_000;

/** Above default unary 32 MiB cap — forces StreamExec buffered fallback. */
export const LARGE_FILE_40_MIB = 40 * 1024 * 1024;
export const largeFileTimeout40Ms = 300_000;

/** Multi-chunk streaming smoke payload (not toy-sized). */
export const STREAM_SMOKE_1_MIB = 1024 * 1024;

export function createPatternedPayload(sizeBytes: number): Uint8Array {
  const payload = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i += 1) {
    payload[i] = i % 256;
  }
  return payload;
}

export function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  // gRPC bytes often arrive as Node Buffer; vitest toEqual treats Buffer ≠ Uint8Array.
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
}

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
  options: { readonly pageSize?: number; readonly showTerminated?: boolean } = {},
): Promise<boolean> {
  let pageToken: string | undefined;

  for (let pageCount = 0; pageCount < 10; pageCount += 1) {
    const result = await client.list({
      pageSize: options.pageSize ?? 100,
      ...(pageToken === undefined ? {} : { pageToken }),
      ...(options.showTerminated === undefined ? {} : { showTerminated: options.showTerminated }),
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

export function logCaughtError(name: string, error: unknown): void {
  console.error(`${name} error:`, error);
}

export function runPython(
  sandbox: Sandbox,
  script: string,
  options: ExecOptions = {},
): Promise<ProcessResult> {
  return sandbox.commands.run(["python", "-c", script], options);
}

export function defaultNetworkOptions(): SandboxRunOptions {
  return {};
}

export function startOptionsForNoInternetNetwork(): SandboxRunOptions {
  return {
    network: {
      denyEgress: true,
    },
  };
}

export const DNS_EGRESS_EXACT = "pypi.org";
export const DNS_EGRESS_WILD = "*.pypi.org";
export const DNS_EGRESS_WILD_HOST = "test.pypi.org";
export const DNS_EGRESS_UNGRANTED = "example.com";
export const dnsEgressSmokeTimeoutMs = 180_000;
export const dnsEgressWaitTimeoutMs = 150_000;

const DNS_NAME_IN_MESSAGE = /dns[_]?name/i;
const DNS_EGRESS_SKIP_REASONS = new Set([
  "CWSANDBOX_NO_SUITABLE_RUNNER",
  "CWSANDBOX_PLACEMENT_CONSTRAINT_UNSATISFIED",
]);

export function startOptionsForDnsNameEgress(): SandboxRunOptions {
  return {
    maxLifetimeSeconds: 300,
    timeoutMs: dnsEgressWaitTimeoutMs,
    network: {
      egress: [{ dnsName: DNS_EGRESS_EXACT }, { dnsName: DNS_EGRESS_WILD }],
    },
  };
}

export async function httpsGetExitCode(
  sandbox: Sandbox,
  url: string,
  timeoutSeconds: number,
): Promise<number> {
  const result = await sandbox.commands.run(
    [
      "python",
      "-c",
      "import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=float(sys.argv[2]))",
      url,
      String(timeoutSeconds),
    ],
    { timeoutMs: (timeoutSeconds + 15) * 1000 },
  );
  logProcessResult(`https ${url}`, result);
  return result.exitCode ?? -1;
}

export function shouldSkipDnsEgress(error: unknown): boolean {
  if (error instanceof CWSandboxValidationError) {
    return DNS_NAME_IN_MESSAGE.test(error.message);
  }
  if (error instanceof CWSandboxTransportError) {
    if (error.reason !== undefined && DNS_EGRESS_SKIP_REASONS.has(error.reason)) {
      return true;
    }
    return DNS_NAME_IN_MESSAGE.test(error.message);
  }
  return false;
}

export function uniqueSmokeTag(): SandboxTag {
  return `cwsandbox-js-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 10)}x`;
}

export function publicHttpsService(port: number, name?: string): Service {
  return {
    endpoint: { auth: "open", kind: "https" },
    ...(name === undefined ? {} : { name }),
    port,
    visibility: "public",
  };
}

export function httpsUrlToWss(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = "wss:";
  return parsed.toString();
}

export function expectExposedPorts(
  ports: readonly SandboxExposedPort[] | undefined,
  expected: readonly number[],
): void {
  const actual = new Set((ports ?? []).map((port) => port.port));
  for (const port of expected) {
    expect(actual.has(port)).toBe(true);
  }
}

export async function waitForServiceUrl(
  sandbox: Sandbox,
  port: number,
  options: { readonly timeoutMs?: number } = {},
): Promise<ServiceUrl> {
  const [service] = await waitForServiceUrls(sandbox, [port], options);
  if (service === undefined) {
    throw new Error(`sandbox '${sandbox.sandboxId}' missing service URL for port ${port}`);
  }
  return service;
}

export async function waitForServiceUrls(
  sandbox: Sandbox,
  ports: readonly number[],
  options: { readonly timeoutMs?: number } = {},
): Promise<readonly ServiceUrl[]> {
  const timeoutMs = options.timeoutMs ?? serviceUrlWaitTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  const wanted = new Set(ports);

  while (Date.now() < deadline) {
    const info = await sandbox.inspect();
    const found = (info.serviceUrls ?? []).filter(
      (service) => wanted.has(service.port) && service.url.startsWith("https://"),
    );
    if (found.length === wanted.size) {
      return ports.map((port) => {
        const service = found.find((entry) => entry.port === port);
        if (service === undefined) {
          throw new Error(`sandbox '${sandbox.sandboxId}' missing service URL for port ${port}`);
        }
        return service;
      });
    }
    await sleep(500);
  }

  throw new Error(
    `sandbox '${sandbox.sandboxId}' had no assigned HTTPS URL for ports ${ports.join(", ")} after ${timeoutMs}ms`,
  );
}

export async function waitForHttpOk(
  url: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? serviceUrlWaitTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.status === 200) {
        return response;
      }
      lastError = new Error(`HTTP ${String(response.status)} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for HTTP 200 from ${url}: ${String(lastError)}`);
}

export async function waitForWebSocketEcho(
  url: string,
  message: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? serviceUrlWaitTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await websocketEchoOnce(url, message, Math.min(10_000, deadline - Date.now()));
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for WebSocket echo from ${url}: ${String(lastError)}`);
}

export async function waitForSandboxListPresence(
  client: SandboxClient,
  sandboxId: string,
  tags: readonly SandboxTag[],
  options: {
    readonly present: boolean;
    readonly showTerminated?: boolean;
    readonly timeoutMs?: number;
  },
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const listOptions =
      options.showTerminated === undefined ? {} : { showTerminated: options.showTerminated };
    const found = await listIncludesSandbox(client, sandboxId, tags, listOptions);
    if (found === options.present) {
      return true;
    }
    await sleep(1000);
  }

  return false;
}

export function withStartedSandbox<TResult>(
  client: SandboxClient,
  options: SandboxRunOptions & { readonly command?: CommandInput },
  callback: (sandbox: Sandbox) => Promise<TResult> | TResult,
): Promise<TResult> {
  const { command, ...runOptions } = options;
  return command === undefined
    ? client.withSandbox(callback, runOptions)
    : client.withSandbox(command, callback, runOptions);
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
    await sandbox.delete({ missingOk: true });
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

function sleep(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function websocketEchoOnce(url: string, message: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`WebSocket timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    socket.addEventListener("open", () => {
      socket.send(message);
    });
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      socket.close();
      resolve(String(event.data));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error for ${url}`));
    });
  });
}
