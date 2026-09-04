// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * Live smoke for runFromFile / withSandboxFromFile.
 *
 * Redis + Python API + Ubuntu primary: running means the health chain passed.
 * Exec from main resolves service hostnames on loopback, PINGs Redis, and
 * fetches /health on the api hostname (PONG from Redis).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Sandbox, SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import { logCaughtError, logProcessResult, smokeConfig, uniqueSmokeTag } from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const LOG_PREFIX = "[from-file-smoke]";
const composePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "testdata",
  "cache-api.docker-compose.yaml",
);
const fromFileWaitTimeoutMs = 150_000;
const fromFileTestTimeoutMs = 180_000;
const defaultResources = {
  limits: { cpu: "500m", memory: "256Mi" },
  requests: { cpu: "500m", memory: "256Mi" },
} as const;
const httpGet = `
set -euo pipefail
exec 3<>/dev/tcp/api/8080
printf 'GET /health HTTP/1.0\\r\\nHost: api\\r\\n\\r\\n' >&3
cat <&3
`;
const redisPing = `
set -euo pipefail
exec 3<>/dev/tcp/cache/6379
printf 'PING\\r\\n' >&3
cat <&3
`;

if (!smokeConfig.hasCredentials) {
  console.log(`${LOG_PREFIX} skip: CWSANDBOX_API_KEY is not set.`);
}

describeWithCredentials("live runFromFile smoke", { sequential: true }, () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "starts dependent Compose services and talks over loopback once running",
    async () => {
      const startedAt = Date.now();
      logFromFileSmoke("runFromFile", { composePath });
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await client.runFromFile(composePath, {
          defaultResources,
          maxLifetimeSeconds: 600,
          primaryService: "main",
          tags: [uniqueSmokeTag()],
          timeoutMs: fromFileWaitTimeoutMs,
        });
        logFromFileSmoke("sandbox started", {
          elapsedMs: Date.now() - startedAt,
          sandboxId: sandbox.sandboxId,
        });
        expect(sandbox.status).toBe("running");

        const hostsCache = await sandbox.commands.run(["getent", "hosts", "cache"]);
        logProcessResult("getent hosts cache", hostsCache);
        expect(hostsCache.exitCode).toBe(0);
        expect(hostsCache.stdout).toContain("127.0.0.1");

        const hostsApi = await sandbox.commands.run(["getent", "hosts", "api"]);
        logProcessResult("getent hosts api", hostsApi);
        expect(hostsApi.exitCode).toBe(0);
        expect(hostsApi.stdout).toContain("127.0.0.1");

        const ping = await sandbox.commands.run(["bash", "-c", redisPing]);
        logProcessResult("redis PING", ping);
        expect(ping.exitCode).toBe(0);
        expect(ping.stdout).toContain("+PONG");

        const health = await sandbox.commands.run(["bash", "-c", httpGet]);
        logProcessResult("api /health", health);
        expect(health.exitCode).toBe(0);
        expect(health.stdout).toContain("PONG");
      } catch (error) {
        logCaughtError(`${LOG_PREFIX} sandbox path`, error);
        throw error;
      } finally {
        logFromFileSmoke("delete sandbox", { sandboxId: sandbox?.sandboxId ?? null });
        await sandbox?.delete({ missingOk: true });
        logFromFileSmoke("done", { elapsedMs: Date.now() - startedAt });
      }
    },
    fromFileTestTimeoutMs,
  );

  it(
    "runs withSandboxFromFile and stops the sandbox after the callback",
    async () => {
      const startedAt = Date.now();
      logFromFileSmoke("withSandboxFromFile");
      let sandboxId: string | undefined;
      try {
        const stdout = await client.withSandboxFromFile(
          composePath,
          async (sandbox) => {
            sandboxId = sandbox.sandboxId;
            logFromFileSmoke("sandbox started", {
              elapsedMs: Date.now() - startedAt,
              sandboxId,
            });
            const hosts = await sandbox.commands.run(["getent", "hosts", "cache"]);
            logProcessResult("getent hosts cache withSandboxFromFile", hosts);
            return hosts.stdout;
          },
          {
            defaultResources,
            maxLifetimeSeconds: 600,
            primaryService: "main",
            tags: [uniqueSmokeTag()],
            timeoutMs: fromFileWaitTimeoutMs,
          },
        );
        expect(stdout).toContain("127.0.0.1");
      } catch (error) {
        logCaughtError(`${LOG_PREFIX} withSandboxFromFile path`, error);
        throw error;
      } finally {
        if (sandboxId !== undefined) {
          logFromFileSmoke("delete leftover after stop", { sandboxId });
          await client.delete(sandboxId, { missingOk: true });
        }
        logFromFileSmoke("done", { elapsedMs: Date.now() - startedAt });
      }
    },
    fromFileTestTimeoutMs,
  );
});

function logFromFileSmoke(step: string, detail?: Record<string, unknown>): void {
  if (detail === undefined) {
    console.log(`${LOG_PREFIX} ${step}`);
    return;
  }
  console.log(`${LOG_PREFIX} ${step}`, detail);
}
