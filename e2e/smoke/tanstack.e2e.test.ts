// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { SandboxClient } from "@coreweave/cwsandbox";
import { cwsandboxTanStackProvider } from "@coreweave/cwsandbox-tanstack";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { defineSandbox, type SandboxHandle } from "@tanstack/ai-sandbox";
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
const threadId = `cwsandbox-js-tanstack-smoke-${tag}`;
const workspaceDir = "/workspace/tanstack-smoke";
const fixtureName = "hello.txt";
const fixturePath = `${workspaceDir}/${fixtureName}`;

describeWithCredentials("live TanStack adapter smoke", { sequential: true }, () => {
  let client: SandboxClient | undefined;
  let definition: ReturnType<typeof defineSandbox>;
  let handle: SandboxHandle | undefined;

  beforeAll(async () => {
    client = createSandboxClientFromEnv();
    definition = defineSandbox({
      id: "cwsandbox-js-tanstack-smoke",
      provider: cwsandboxTanStackProvider({
        client,
        createOptions: { tags: [tag] },
      }),
    });
    handle = await definition.ensure({
      runId: `create-${Date.now()}`,
      threadId,
    });
    console.log(`Started TanStack sandbox: ${handle.id}`);
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
      console.log(`Destroying TanStack sandbox: ${handle.id}`);
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
    "lists a workspace file through the TanStack handle",
    async () => {
      const active = currentHandle();
      await active.fs.mkdir(workspaceDir);
      await active.fs.write(fixturePath, "hello from tanstack smoke");

      const entries = await active.fs.list(workspaceDir);
      expect(entries).toEqual(
        expect.arrayContaining([
          {
            name: fixtureName,
            path: fixturePath,
            type: "file",
          },
        ]),
      );
    },
    testTimeoutMs,
  );

  it(
    "runs a command with cwd and merged handle and process env",
    async () => {
      const active = currentHandle();
      await active.env.set({ FROM_HANDLE: "yes" });
      const { exitCode, stdout } = await active.process.exec(
        'printf "%s:%s\\n" "$FROM_HANDLE" "$FROM_PROCESS"; pwd',
        {
          cwd: workspaceDir,
          env: { FROM_PROCESS: "yes" },
        },
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("yes:yes");
      expect(stdout).toContain(workspaceDir);
    },
    testTimeoutMs,
  );

  it(
    "resumes the same sandbox on a later ensure and still sees the file",
    async () => {
      const firstId = currentHandle().id;
      const resumed = await definition.ensure({
        runId: `resume-${Date.now()}`,
        threadId,
      });
      handle = resumed;

      expect(resumed.id).toBe(firstId);
      const entries = await resumed.fs.list(workspaceDir);
      expect(entries).toEqual(
        expect.arrayContaining([
          {
            name: fixtureName,
            path: fixturePath,
            type: "file",
          },
        ]),
      );
    },
    testTimeoutMs,
  );

  function currentHandle(): SandboxHandle {
    if (handle === undefined) {
      throw new Error("TanStack sandbox handle has not been started.");
    }
    return handle;
  }
});

if (!smokeConfig.hasCredentials) {
  console.log("Skipping live TanStack adapter smoke e2e: CWSANDBOX_API_KEY is not set.");
}
