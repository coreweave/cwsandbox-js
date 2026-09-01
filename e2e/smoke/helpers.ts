// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CWSandboxNotImplementedError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
  type CommandInput,
  type ExecOptions,
  type LogResumeCursor,
  type ProcessResult,
  type Sandbox,
  type SandboxClient,
  type SandboxExposedPort,
  type SandboxId,
  type SandboxListOptions,
  type SandboxRunOptions,
  type SandboxStatus,
  type SandboxTag,
  type Service,
  type ServiceUrl,
} from "@coreweave/cwsandbox";
import { expect } from "vitest";

export interface SmokeConfig {
  readonly hasCredentials: boolean;
  readonly hasTemplateSmoke: boolean;
  readonly hasWandbSecretsSmoke: boolean;
  readonly templateSmoke:
    | {
        readonly templateId: string;
      }
    | undefined;
  readonly wandbSecretsSmoke:
    | {
        readonly envVar: string;
        readonly expected: string;
        readonly name: string;
        readonly store: string;
      }
    | undefined;
}

export type OpCapture = { failed: false } | { failed: true; error: unknown };

const smokeDir = dirname(fileURLToPath(import.meta.url));

export const mountedBinaryContent = new Uint8Array([0, 1, 2, 127, 128, 255]);
export const dualHttpServerScript = readSmokeScript("dual-http-server.js");
export const httpsTimeoutHandlerScript = readSmokeScript("https-timeout-handler.js");
export const noInternetProbeScript = readSmokeScript("no-internet-probe.py");
export const smokeConfig = createSmokeConfig();
export const terminalStatuses = new Set<SandboxStatus>(["completed", "failed", "terminated"]);
export const testTimeoutMs = 120_000;
export const serviceUrlWaitTimeoutMs = 60_000;
export const websocketEchoScript = readSmokeScript("websocket-echo.js");

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

export function sortedSandboxIds(ids: readonly SandboxId[]): SandboxId[] {
  return [...ids].sort();
}

export async function waitUntilListCondition(
  client: SandboxClient,
  options: {
    readonly expectedSandboxIds: readonly SandboxId[];
    readonly listOptions: Omit<SandboxListOptions, "timeoutMs">;
    readonly pollTimeoutMs: number;
    readonly requestTimeoutMs?: number;
  },
): Promise<readonly SandboxId[]> {
  const deadline = Date.now() + options.pollTimeoutMs;
  const expected = sortedSandboxIds(options.expectedSandboxIds);
  let lastIds: readonly SandboxId[] = [];

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    const requestTimeoutMs = Math.min(options.requestTimeoutMs ?? remaining, remaining);
    const result = await client.list({
      ...options.listOptions,
      timeoutMs: requestTimeoutMs,
    });
    lastIds = result.sandboxes.map((sandbox) => sandbox.sandboxId);
    if (sortedSandboxIds(lastIds).join("\0") === expected.join("\0")) {
      return expected;
    }
    await sleep(1000);
  }

  throw new Error(
    `list condition timed out after ${String(options.pollTimeoutMs)}ms: expected ${JSON.stringify(expected)}, last observed ${JSON.stringify(sortedSandboxIds(lastIds))}`,
  );
}

export function requireLogResumeCursor(cursor: {
  readonly offset?: bigint | number | string;
  readonly sessionId?: string;
}): LogResumeCursor {
  if (cursor.sessionId === undefined || cursor.sessionId.trim() === "") {
    throw new Error("log resume sessionId is required");
  }
  if (cursor.offset === undefined) {
    throw new Error("log resume offset is required");
  }
  if (typeof cursor.offset === "string" && cursor.offset.trim() === "") {
    throw new Error("log resume offset is required");
  }
  if (typeof cursor.offset === "number") {
    throw new Error("log resume offset must be a string or bigint");
  }
  return { offset: cursor.offset, sessionId: cursor.sessionId };
}

export async function rejectAndNarrow<T>(
  action: () => Promise<unknown>,
  guard: (error: unknown) => error is T,
): Promise<T> {
  try {
    await action();
  } catch (error) {
    if (guard(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("operation resolved unexpectedly");
}

export async function waitUntilFromIdTerminal(
  client: SandboxClient,
  sandboxId: SandboxId,
  options: { readonly timeoutMs?: number } = {},
): Promise<Sandbox> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus: SandboxStatus | undefined;

  while (Date.now() < deadline) {
    const sandbox = await client.fromId(sandboxId);
    lastStatus = await sandbox.getStatus();
    if (terminalStatuses.has(lastStatus)) {
      return sandbox;
    }
    await sleep(1000);
  }

  throw new Error(
    `sandbox '${sandboxId}' was not terminal via fromId after ${String(timeoutMs)}ms: last status ${String(lastStatus)}`,
  );
}

export async function captureOp(action: () => Promise<void>): Promise<OpCapture> {
  try {
    await action();
    return { failed: false };
  } catch (error) {
    return { failed: true, error };
  }
}

export function combineCleanupError(primary: OpCapture, cleanup: OpCapture): void {
  if (primary.failed && cleanup.failed) {
    throw new AggregateError([primary.error, cleanup.error]);
  }
  if (primary.failed) {
    throw primary.error;
  }
  if (cleanup.failed) {
    throw cleanup.error;
  }
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

export const DNS_EGRESS_EXACT = "pypi.org";
export const DNS_EGRESS_WILD = "*.pypi.org";
export const DNS_EGRESS_WILD_HOST = "test.pypi.org";
export const DNS_EGRESS_UNGRANTED = "example.com";
export const dnsEgressSmokeTimeoutMs = 180_000;
export const dnsEgressWaitTimeoutMs = 150_000;

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

export function startOptionsForNoInternetNetwork(): SandboxRunOptions {
  return {
    network: {
      denyEgress: true,
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
  return (
    error instanceof CWSandboxTransportError &&
    error.reason !== undefined &&
    DNS_EGRESS_SKIP_REASONS.has(error.reason)
  );
}

export function shouldSkipHttpsRequestTimeouts(error: unknown): boolean {
  return (
    error instanceof CWSandboxTransportError &&
    error.reason === "CWSANDBOX_HTTPS_REQUEST_TIMEOUTS_NOT_SUPPORTED"
  );
}

export function shouldSkipDirectDataPlane(error: unknown): boolean {
  if (error instanceof CWSandboxUnavailableError || error instanceof CWSandboxNotImplementedError) {
    return true;
  }
  if (!(error instanceof CWSandboxTransportError)) {
    return false;
  }
  const code = String(error.transportCode ?? "").toUpperCase();
  return code === "UNIMPLEMENTED" || code === "12";
}

export function uniqueSmokeTag(): SandboxTag {
  return `cwsandbox-js-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 10)}x`;
}

export function publicHttpsService(
  port: number,
  name?: string,
  options: { readonly requestTimeoutSeconds?: number } = {},
): Service {
  return {
    endpoint: {
      auth: "open",
      kind: "https",
      ...(options.requestTimeoutSeconds === undefined
        ? {}
        : { requestTimeoutSeconds: options.requestTimeoutSeconds }),
    },
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

export function normalizedListenPorts(ports: readonly SandboxExposedPort[] | undefined): readonly {
  readonly name: string | undefined;
  readonly port: number;
  readonly protocol: string | undefined;
}[] {
  return [...(ports ?? [])]
    .map((port) => ({ name: port.name, port: port.port, protocol: port.protocol }))
    .sort((left, right) => {
      if (left.port !== right.port) {
        return left.port - right.port;
      }
      return (left.name ?? "").localeCompare(right.name ?? "");
    });
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
  const hasCredentials = Boolean(process.env["CWSANDBOX_API_KEY"]?.trim());
  const templateId = trimEnv("CWSANDBOX_TEMPLATE_ID");
  const templateSmoke = hasCredentials && templateId !== undefined ? { templateId } : undefined;
  const wandbSecretsSmoke = readWandbSecretsSmokeConfig();
  return {
    hasCredentials,
    hasTemplateSmoke: templateSmoke !== undefined,
    hasWandbSecretsSmoke: wandbSecretsSmoke !== undefined,
    templateSmoke,
    wandbSecretsSmoke,
  };
}

function trimEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
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
