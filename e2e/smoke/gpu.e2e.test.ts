// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * Live GPU smoke. Opt-in with CWSANDBOX_GPU_SMOKE=1 because it needs GPU
 * quota in the org of CWSANDBOX_API_KEY. A capacity or quota rejection fails
 * the test.
 */

import type { Sandbox, SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import { logCaughtError, logProcessResult, smokeConfig, uniqueSmokeTag } from "./helpers.js";

const hasGpuSmoke = smokeConfig.hasCredentials && process.env["CWSANDBOX_GPU_SMOKE"] === "1";
const describeWithGpuSmoke = hasGpuSmoke ? describe : describe.skip;
const LOG_PREFIX = "[gpu-smoke]";
const GPU_IMAGE = "nvidia/cuda:12.4.1-base-ubuntu22.04";
const gpuWaitTimeoutMs = 240_000;
const gpuSmokeTimeoutMs = 300_000;

if (!hasGpuSmoke) {
  console.log(`${LOG_PREFIX} skip: set CWSANDBOX_GPU_SMOKE=1 to run (needs GPU quota).`);
}

describeWithGpuSmoke("live GPU smoke", { sequential: true }, () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "creates a sandbox with one GPU that nvidia-smi can see",
    async () => {
      const startedAt = Date.now();
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await client.create({
          containerImage: GPU_IMAGE,
          maxLifetimeSeconds: 300,
          resources: { cpu: "2", memory: "8Gi", gpu: { count: 1 } },
          tags: [uniqueSmokeTag()],
          timeoutMs: gpuWaitTimeoutMs,
        });
        console.log(`${LOG_PREFIX} running`, {
          elapsedMs: Date.now() - startedAt,
          resourceLimits: sandbox.resourceLimits,
          resourceRequests: sandbox.resourceRequests,
          sandboxId: sandbox.sandboxId,
        });
        expect(sandbox.status).toBe("running");
        // The server echoes the GPU on effective requests, not limits.
        expect(sandbox.resourceRequests?.gpu).toEqual({ count: 1 });

        const result = await sandbox.commands.run(["nvidia-smi", "-L"]);
        logProcessResult("nvidia-smi -L", result);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^GPU 0: /m);

        const info = await sandbox.inspect();
        console.log(`${LOG_PREFIX} inspect`, {
          resourceLimits: info.resourceLimits,
          resourceRequests: info.resourceRequests,
        });
        expect(info.resourceRequests?.gpu).toEqual({ count: 1 });
      } catch (error) {
        logCaughtError(LOG_PREFIX, error);
        throw error;
      } finally {
        await sandbox?.stop({ missingOk: true });
        console.log(`${LOG_PREFIX} done`, { elapsedMs: Date.now() - startedAt });
      }
    },
    gpuSmokeTimeoutMs,
  );
});
