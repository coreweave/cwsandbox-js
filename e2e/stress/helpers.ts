// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CWSandboxNotFoundError,
  CWSandboxTimeoutError,
  type Sandbox,
  type SandboxClient,
  type SandboxInfo,
} from "@coreweave/cwsandbox";
import { afterAll, describe, expect } from "vitest";

import { smokeConfig, testTimeoutMs, uniqueSmokeTag } from "../smoke/helpers.js";

export type StressLevel = "heavy" | "standard";

export interface StressLimits {
  readonly batchFileCount: number;
  readonly fileBytes: number;
  readonly followLoops: number;
  readonly lineCount: number;
  readonly paginationSandboxes: number;
  readonly streamBytes: number;
  readonly stdinChunks: number;
}

export interface StressConfig {
  readonly hasCredentials: boolean;
  readonly level: StressLevel;
  readonly limits: StressLimits;
  readonly tag: string;
  readonly timeoutMs: number;
}

interface StressSummary {
  bytesStreamed: number;
  cleanupCount: number;
  filesWritten: number;
  logLinesRead: number;
  sandboxesCreated: number;
}

interface RegisteredSandbox {
  readonly marker: string;
  readonly sandbox: Sandbox;
}

export interface StressManifest {
  readonly area: string;
  readonly heavy?: boolean;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly maxSandboxes?: number;
  readonly name: string;
  readonly runtime: string;
}

export interface StressContext {
  readonly marker: string;
  collectFor<T>(stream: AsyncIterable<T>, count: number, phase?: string): Promise<T[]>;
  collectUntil<T>(
    stream: AsyncIterable<T>,
    predicate: (value: T) => boolean | Promise<boolean>,
    options?: { readonly limit?: number; readonly phase?: string },
  ): Promise<T[]>;
  createSandbox(command: readonly string[]): Promise<Sandbox>;
  phase<T>(name: string, promise: Promise<T>, timeoutMs?: number): Promise<T>;
  waitForLine(
    stream: AsyncIterable<string>,
    predicate: (line: string) => boolean,
    options?: { readonly limit?: number; readonly phase?: string },
  ): Promise<string[]>;
  withCompletedSandbox<TResult>(
    command: readonly string[],
    callback: (sandbox: Sandbox) => Promise<TResult>,
  ): Promise<TResult>;
  withRunningSandbox<TResult>(
    command: readonly string[],
    callback: (sandbox: Sandbox) => Promise<TResult>,
  ): Promise<TResult>;
  writeTrigger(sandbox: Sandbox, name?: string): Promise<string>;
}

const standardLimits: StressLimits = {
  batchFileCount: 50,
  fileBytes: 64 * 1024,
  followLoops: 3,
  lineCount: 200,
  paginationSandboxes: 3,
  streamBytes: 128 * 1024,
  stdinChunks: 40,
};

const heavyLimits: StressLimits = {
  batchFileCount: 100,
  fileBytes: 256 * 1024,
  followLoops: 5,
  lineCount: 500,
  paginationSandboxes: 5,
  streamBytes: 512 * 1024,
  stdinChunks: 100,
};

export const stressConfig: StressConfig = {
  hasCredentials: smokeConfig.hasCredentials,
  level: process.argv.includes("heavy") ? "heavy" : "standard",
  limits: process.argv.includes("heavy") ? heavyLimits : standardLimits,
  tag: uniqueSmokeTag().replace("smoke", "stress"),
  timeoutMs: testTimeoutMs,
};

const registeredSandboxes: RegisteredSandbox[] = [];
const cleanedSandboxIds = new Set<string>();
const manifests: StressManifest[] = [];
const activeStatuses = new Set(["creating", "pending", "paused", "running", "terminating"]);

export function describeStress(name: string, callback: () => void): void {
  const run = stressConfig.hasCredentials ? describe : describe.skip;
  run(name, { sequential: true }, callback);
}

const summary: StressSummary = {
  bytesStreamed: 0,
  cleanupCount: 0,
  filesWritten: 0,
  logLinesRead: 0,
  sandboxesCreated: 0,
};

export function installStressSummary(clientRef: () => SandboxClient | undefined): void {
  afterAll(async () => {
    const client = clientRef();
    if (client !== undefined && stressConfig.hasCredentials) {
      await cleanupRegisteredSandboxes(client);
      const leaked = await waitForNoRunningStressSandboxes(client);
      if (leaked.length > 0) {
        await writeFailureArtifact({
          error: `Leaked stress sandboxes: ${JSON.stringify(leaked)}`,
          phase: "cleanup",
        });
      }

      expect(leaked, `Leaked stress sandboxes: ${JSON.stringify(leaked)}`).toEqual([]);
    }

    console.log(
      `stress summary: ${JSON.stringify({
        ...summary,
        level: stressConfig.level,
        manifests,
        tag: stressConfig.tag,
      })}`,
    );
  }, stressConfig.timeoutMs);
}

export function registerStressManifest(manifest: StressManifest): void {
  manifests.push(manifest);
}

export function recordBytes(value: number): void {
  summary.bytesStreamed += value;
}

export function recordCleanup(): void {
  summary.cleanupCount += 1;
}

export function recordFiles(value: number): void {
  summary.filesWritten += value;
}

export function recordLogLines(value: number): void {
  summary.logLinesRead += value;
}

export function recordSandbox(): void {
  summary.sandboxesCreated += 1;
}

export function stressMarker(name: string): string {
  return `${stressConfig.tag}-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function assertIncremental(
  arrivals: readonly number[],
  options: { readonly minEvents: number; readonly minSpreadMs: number },
): void {
  expect(arrivals.length).toBeGreaterThanOrEqual(options.minEvents);
  const firstArrival = arrivals[0];
  const lastArrival = arrivals.at(-1);
  expect(firstArrival).toBeDefined();
  expect(lastArrival).toBeDefined();
  const arrivalSpread =
    firstArrival === undefined || lastArrival === undefined ? 0 : lastArrival - firstArrival;
  expect(arrivalSpread).toBeGreaterThanOrEqual(options.minSpreadMs);
}

export function textPayload(bytes: number, marker: string): string {
  const repeated = `${marker}-`.repeat(Math.ceil(bytes / (marker.length + 1)));
  return repeated.slice(0, bytes);
}

export function binaryPayload(bytes: number): Uint8Array {
  return Uint8Array.from({ length: bytes }, (_, index) => index % 251);
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function collectWithLimit<T>(
  stream: AsyncIterable<T>,
  limit: number,
  stop?: (value: T) => Promise<void> | void,
): Promise<T[]> {
  const values: T[] = [];

  for await (const value of stream) {
    values.push(value);
    await stop?.(value);
    if (values.length >= limit) {
      break;
    }
  }

  return values;
}

export async function withStressContext<TResult>(
  client: SandboxClient,
  name: string,
  callback: (context: StressContext) => Promise<TResult>,
): Promise<TResult> {
  const marker = stressMarker(name);
  const context = createStressContext(client, marker);

  try {
    return await callback(context);
  } catch (error) {
    await writeFailureArtifact({ error, marker, phase: "test" });
    throw error;
  }
}

export async function withStressSandbox<TResult>(
  client: SandboxClient,
  command: readonly string[],
  callback: (sandbox: Sandbox) => Promise<TResult>,
): Promise<TResult> {
  return withStressContext(client, "legacy", (context) =>
    context.withRunningSandbox(command, callback),
  );
}

export async function createStressSandbox(
  client: SandboxClient,
  marker: string,
  command: readonly string[],
): Promise<Sandbox> {
  const sandbox = await client.run(command, { tags: [stressConfig.tag] });
  registeredSandboxes.push({ marker, sandbox });
  recordSandbox();
  return sandbox;
}

export async function withTimeout<T>(
  phase: string,
  promise: Promise<T>,
  timeoutMs = stressConfig.timeoutMs,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new CWSandboxTimeoutError(`Timed out during stress phase: ${phase}`, {
          operation: phase,
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function expectSandboxHealthy(sandbox: Sandbox): Promise<void> {
  const result = await sandbox.commands.run(["/bin/sh", "-lc", "echo healthy"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("healthy");
}

async function logDiagnostics(sandbox: Sandbox, error: unknown): Promise<void> {
  const logs = await sandbox.logs.read({ tailLines: 5 }).catch(() => []);
  console.error(
    `stress diagnostics: ${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      logs,
      sandboxId: sandbox.sandboxId,
      tag: stressConfig.tag,
    })}`,
  );
  const marker = registeredSandboxes.find((entry) => entry.sandbox === sandbox)?.marker;
  await writeFailureArtifact({
    error,
    logs,
    ...(marker === undefined ? {} : { marker }),
    sandboxId: sandbox.sandboxId,
  });
}

function createStressContext(client: SandboxClient, marker: string): StressContext {
  return {
    marker,
    collectFor: (stream, count, phase = `collect ${count} items`) =>
      withTimeout(phase, collectWithLimit(stream, count)),
    collectUntil: (stream, predicate, options = {}) =>
      collectUntil(stream, predicate, {
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        phase: options.phase ?? "collect until predicate",
      }),
    createSandbox: (command) => createStressSandbox(client, marker, command),
    phase: (name, promise, timeoutMs) => withTimeout(`${marker}: ${name}`, promise, timeoutMs),
    waitForLine: (stream, predicate, options = {}) =>
      collectUntil(stream, predicate, {
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        phase: options.phase ?? "wait for log line",
      }),
    withCompletedSandbox: (command, callback) =>
      withTrackedSandbox(client, marker, command, "completed", callback),
    withRunningSandbox: (command, callback) =>
      withTrackedSandbox(client, marker, command, "running", callback),
    async writeTrigger(sandbox, name = "go") {
      const path = `/tmp/${marker}.${name}`;
      await withTimeout(`write trigger ${name}`, sandbox.files.write(path, "go"));
      return path;
    },
  };
}

async function collectUntil<T>(
  stream: AsyncIterable<T>,
  predicate: (value: T) => boolean | Promise<boolean>,
  options: { readonly limit?: number; readonly phase: string },
): Promise<T[]> {
  return withTimeout(
    options.phase,
    (async () => {
      const values: T[] = [];
      const limit = options.limit ?? 100;

      for await (const value of stream) {
        values.push(value);
        if (await predicate(value)) {
          break;
        }
        if (values.length >= limit) {
          break;
        }
      }

      return values;
    })(),
  );
}

async function withTrackedSandbox<TResult>(
  client: SandboxClient,
  marker: string,
  command: readonly string[],
  targetStatus: "completed" | "running",
  callback: (sandbox: Sandbox) => Promise<TResult>,
): Promise<TResult> {
  const sandbox = await createStressSandbox(client, marker, command);

  try {
    await withTimeout(
      `wait for sandbox ${targetStatus}`,
      sandbox.wait({
        targetStatus,
        timeoutMs: stressConfig.timeoutMs,
      }),
    );
    return await callback(sandbox);
  } catch (error) {
    await logDiagnostics(sandbox, error);
    throw error;
  } finally {
    await cleanupSandbox(sandbox);
  }
}

async function cleanupSandbox(sandbox: Sandbox): Promise<void> {
  if (cleanedSandboxIds.has(sandbox.sandboxId)) {
    return;
  }

  await sandbox.delete().catch(async () => {
    await sandbox.stop().catch(() => undefined);
  });
  await waitUntilStopped(sandbox).catch(() => undefined);
  cleanedSandboxIds.add(sandbox.sandboxId);
  recordCleanup();
}

async function cleanupRegisteredSandboxes(client: SandboxClient): Promise<void> {
  await Promise.all(
    registeredSandboxes.map(async ({ sandbox }) => {
      await cleanupSandbox(sandbox);
    }),
  );

  for (let round = 0; round < 6; round += 1) {
    const leaked = await listActiveStressSandboxes(client);
    if (leaked.length === 0) {
      return;
    }

    await Promise.all(leaked.map((sandbox) => cleanupSandboxInfo(client, sandbox)));
    await delay(1_000);
  }
}

async function waitForNoRunningStressSandboxes(
  client: SandboxClient,
  attempts = 60,
): Promise<readonly SandboxInfo[]> {
  let running: readonly SandboxInfo[] = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    running = await listActiveStressSandboxes(client);

    if (running.length === 0) {
      return [];
    }

    await delay(1_000);
  }

  return running;
}

async function listActiveStressSandboxes(client: SandboxClient): Promise<readonly SandboxInfo[]> {
  const sandboxes: SandboxInfo[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 20; page += 1) {
    const result = await client.list({
      includeStopped: false,
      pageSize: 100,
      ...(pageToken === undefined ? {} : { pageToken }),
      tags: [stressConfig.tag],
    });

    sandboxes.push(...result.sandboxes.filter(isActiveSandboxInfo));
    if (result.nextPageToken === undefined) {
      break;
    }
    pageToken = result.nextPageToken;
  }

  return sandboxes;
}

async function cleanupSandboxInfo(client: SandboxClient, sandbox: SandboxInfo): Promise<void> {
  await client.delete(sandbox.sandboxId).catch(async () => {
    const attached = await client.fromId(sandbox.sandboxId).catch(() => undefined);
    await attached?.stop().catch(() => undefined);
  });
}

async function waitUntilStopped(sandbox: Sandbox): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const status = await sandbox.getStatus();
      if (status !== "running" && status !== "creating" && status !== "pending") {
        return;
      }
    } catch (error) {
      if (error instanceof CWSandboxNotFoundError) {
        return;
      }
    }

    await delay(1_000);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isActiveSandboxInfo(sandbox: SandboxInfo): boolean {
  return activeStatuses.has(sandbox.status);
}

async function writeFailureArtifact(details: {
  readonly error: unknown;
  readonly logs?: readonly string[];
  readonly marker?: string;
  readonly phase?: string;
  readonly sandboxId?: string;
}): Promise<void> {
  const artifactDir = ".stress-artifacts";
  mkdirSync(artifactDir, { recursive: true });
  const filename = join(artifactDir, `${Date.now()}-${details.marker ?? "unknown"}.json`);
  const artifact = {
    error: details.error instanceof Error ? details.error.message : String(details.error),
    level: stressConfig.level,
    limits: stressConfig.limits,
    logs: details.logs ?? [],
    marker: details.marker,
    phase: details.phase,
    sandboxId: details.sandboxId,
    tag: stressConfig.tag,
  };

  writeFileSync(filename, JSON.stringify(artifact, null, 2));
}

if (!stressConfig.hasCredentials) {
  console.log("Skipping live CWSandbox stress smoke e2e: CWSANDBOX_API_KEY is not set.");
}
