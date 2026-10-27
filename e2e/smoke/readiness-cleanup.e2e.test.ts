// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * Live smoke for readiness-failure cleanup on `run`.
 *
 * Starts a sandbox from an image that cannot be pulled, so the readiness wait
 * rejects. The SDK should stop the accepted sandbox before rethrowing, which
 * leaves it terminating or terminal when listed by its tag.
 */

import type { SandboxClient, SandboxInfo, SandboxStatus } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import { logCaughtError, smokeConfig, terminalStatuses, uniqueSmokeTag } from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const LOG_PREFIX = "[readiness-cleanup-smoke]";
const missingImage = "ghcr.io/coreweave/cwsandbox-js-smoke-missing-image:does-not-exist";
// Shorter than the backend takes to fail an unpullable image on its own, so a
// leaked sandbox would still list as creating.
const readinessTimeoutMs = 15_000;
const listPollTimeoutMs = 5_000;
const readinessCleanupTestTimeoutMs = 120_000;

describeWithCredentials("live readiness-failure cleanup smoke", { sequential: true }, () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "stops the sandbox when run fails to become ready",
    async () => {
      const tag = uniqueSmokeTag();
      try {
        let thrown: unknown;
        try {
          await client.run(["sleep", "infinity"], {
            containerImage: missingImage,
            maxLifetimeSeconds: 300,
            tags: [tag],
            timeoutMs: readinessTimeoutMs,
          });
        } catch (error) {
          thrown = error;
        }
        logCaughtError(`${LOG_PREFIX} run`, thrown);
        expect(thrown).toBeInstanceOf(Error);

        const sandboxes = await listUntilStopped(client, tag);
        console.log(LOG_PREFIX, "listed", sandboxes);
        expect(sandboxes).toHaveLength(1);
        expect(sandboxes.every((sandbox) => isStoppedStatus(sandbox.status))).toBe(true);
      } finally {
        const { sandboxes } = await client.list({ showTerminated: true, tags: [tag] });
        for (const sandbox of sandboxes) {
          await client.delete(sandbox.sandboxId, { missingOk: true });
        }
      }
    },
    readinessCleanupTestTimeoutMs,
  );
});

async function listUntilStopped(
  client: SandboxClient,
  tag: string,
): Promise<readonly SandboxInfo[]> {
  const deadline = Date.now() + listPollTimeoutMs;
  let sandboxes: readonly SandboxInfo[] = [];
  while (Date.now() < deadline) {
    ({ sandboxes } = await client.list({ showTerminated: true, tags: [tag] }));
    if (sandboxes.length > 0 && sandboxes.every((sandbox) => isStoppedStatus(sandbox.status))) {
      return sandboxes;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
  return sandboxes;
}

function isStoppedStatus(status: SandboxStatus): boolean {
  return status === "terminating" || terminalStatuses.has(status);
}
