// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { SandboxClient } from "@coreweave/cwsandbox";
import { coreweave } from "@coreweave/cwsandbox-computesdk";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  captureOp,
  combineCleanupError,
  smokeConfig,
  testTimeoutMs,
  uniqueSmokeTag,
} from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const tag = uniqueSmokeTag();
const fixtureDir = "/tmp/computesdk-smoke/nested";
const fixtureName = "hello.txt";
const fixturePath = `${fixtureDir}/${fixtureName}`;

type ComputeProvider = ReturnType<typeof coreweave>;
type ComputeSandbox = Awaited<ReturnType<ComputeProvider["sandbox"]["create"]>>;

describeWithCredentials("live ComputeSDK adapter smoke", { sequential: true }, () => {
  let client: SandboxClient | undefined;
  let compute: ComputeProvider;
  let handle: ComputeSandbox | undefined;

  beforeAll(async () => {
    client = createSandboxClientFromEnv();
    compute = coreweave({
      client,
      ownerTag: tag,
    });
    handle = await compute.sandbox.create({ waitUntilRunningTimeoutMs: 90_000 });
    console.log(`Started ComputeSDK sandbox: ${handle.sandboxId}`);
  }, testTimeoutMs);

  afterAll(async () => {
    const activeClient = client;
    if (activeClient === undefined) {
      return;
    }

    const handleCleanup = await captureOp(async () => {
      if (handle === undefined) {
        return;
      }
      console.log(`Destroying ComputeSDK sandbox: ${handle.sandboxId}`);
      await handle.destroy();
    });
    const tagCleanup = await captureOp(async () => {
      const listed = await activeClient.list({ tags: [tag] });
      await Promise.all(
        listed.sandboxes.map((sandbox) =>
          activeClient.delete(sandbox.sandboxId, { missingOk: true }),
        ),
      );
    });
    combineCleanupError(handleCleanup, tagCleanup);
  }, testTimeoutMs);

  it(
    "writes a nested file and lists it through the ComputeSDK handle",
    async () => {
      const active = currentHandle();
      await active.filesystem.writeFile(fixturePath, "hello from computesdk smoke");

      const entries = await active.filesystem.readdir(fixtureDir);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: fixtureName,
            type: "file",
          }),
        ]),
      );
    },
    testTimeoutMs,
  );

  it(
    "lists and reconnects to the same sandbox through the provider",
    async () => {
      const firstId = currentHandle().sandboxId;
      const listed = await compute.sandbox.list();
      expect(listed.map((entry) => entry.sandboxId)).toContain(firstId);

      const resumed = await compute.sandbox.getById(firstId);
      expect(resumed?.sandboxId).toBe(firstId);
    },
    testTimeoutMs,
  );

  function currentHandle(): ComputeSandbox {
    if (handle === undefined) {
      throw new Error("ComputeSDK sandbox handle has not been started.");
    }
    return handle;
  }
});

if (!smokeConfig.hasCredentials) {
  console.log("Skipping live ComputeSDK adapter smoke e2e: CWSANDBOX_API_KEY is not set.");
}
