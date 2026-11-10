// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * Live smoke for sandbox display names: read-back, lookup by name, the
 * duplicate-name error, and reuse after the first sandbox is terminal.
 */

import { CWSandboxNameInUseError, type Sandbox, type SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import { smokeConfig, uniqueSmokeTag } from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const displayNameTestTimeoutMs = 240_000;
const compose = new TextEncoder().encode(`services:
  main:
    image: alpine:3.20
    command: ["sleep", "3600"]
`);

if (!smokeConfig.hasCredentials) {
  console.log("[display-name-smoke] skip: CWSANDBOX_API_KEY is not set.");
}

describeWithCredentials("live display name smoke", { sequential: true }, () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "names a sandbox, resolves the name, rejects a duplicate, and frees it after stop",
    async () => {
      const tag = uniqueSmokeTag();
      const displayName = `name-${tag}`;
      const tags = [tag];
      const started: Sandbox[] = [];
      try {
        const first = await client.create({ displayName, maxLifetimeSeconds: 300, tags });
        started.push(first);
        expect(first.displayName).toBe(displayName);

        const info = await client.get(displayName);
        expect(info.sandboxId).toBe(first.sandboxId);
        expect(info.displayName).toBe(displayName);
        const adopted = await client.fromId(displayName);
        expect(adopted.sandboxId).toBe(first.sandboxId);
        expect(adopted.displayName).toBe(displayName);
        const listed = await client.list({ tags });
        expect(listed.sandboxes.map((sandbox) => sandbox.displayName)).toEqual([displayName]);

        await expect(
          client.create({ displayName, maxLifetimeSeconds: 300, tags }).then((sandbox) => {
            started.push(sandbox);
          }),
        ).rejects.toBeInstanceOf(CWSandboxNameInUseError);
        await expect(
          client
            .runFromFile(compose, {
              displayName,
              maxLifetimeSeconds: 300,
              primaryService: "main",
              tags,
              waitUntilRunning: false,
            })
            .then((sandbox) => {
              started.push(sandbox);
            }),
        ).rejects.toBeInstanceOf(CWSandboxNameInUseError);

        await first.stop();

        const reused = await client.runFromFile(compose, {
          displayName,
          maxLifetimeSeconds: 300,
          primaryService: "main",
          tags,
          waitUntilRunning: false,
        });
        started.push(reused);
        expect(reused.sandboxId).not.toBe(first.sandboxId);
        expect(reused.displayName).toBe(displayName);
        expect((await client.get(displayName)).sandboxId).toBe(reused.sandboxId);
        expect((await client.get(first.sandboxId)).displayName).toBe(displayName);
      } finally {
        await Promise.all(started.map((sandbox) => sandbox.delete({ missingOk: true })));
      }
    },
    displayNameTestTimeoutMs,
  );
});
