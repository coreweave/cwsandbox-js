// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { randomUUID } from "node:crypto";

import type { SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import { logProcessResult, smokeConfig, withDedicatedTaggedSandbox } from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const MOUNT_PATH = "/workspace";
const snapshotTimeoutMs = 10 * 60 * 1000;

describeWithCredentials("live file-system snapshot smoke", { sequential: true }, () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "writes on a scratch mount, snapshots, restores, and deletes the snapshot",
    async () => {
      const payload = `hello from snapshot smoke ${randomUUID()}`;
      const snapshotIds: string[] = [];

      try {
        let snapshotId: string | undefined;
        let sourceSandboxId: string | undefined;

        await withDedicatedTaggedSandbox(
          client,
          {
            create: (tag) =>
              client.create({
                fileSystemSnapshot: {
                  mountPath: MOUNT_PATH,
                  size: "1Gi",
                },
                maxLifetimeSeconds: 600,
                tags: [tag],
              }),
            waitUntilRunning: true,
          },
          async (source) => {
            sourceSandboxId = source.sandboxId;
            console.log(`Started sandbox: ${source.sandboxId}`);

            const write = await source.exec([
              "sh",
              "-c",
              `echo '${payload}' > ${MOUNT_PATH}/data.txt`,
            ]);
            logProcessResult("seed scratch mount", write);
            expect(write.exitCode).toBe(0);

            const snapshot = await source.snapshot();
            snapshotId = snapshot.snapshotId;
            snapshotIds.push(snapshot.snapshotId);
            expect(snapshot.snapshotId).toMatch(/\S/);
            expect(snapshot.state).toBe("ready");
            console.log("created snapshot", {
              objectBucket: snapshot.objectBucket,
              snapshotId: snapshot.snapshotId,
              sizeBytes: snapshot.sizeBytes,
              sourceSandboxId: source.sandboxId,
              state: snapshot.state,
              trigger: snapshot.trigger,
            });
          },
        );

        expect(snapshotId).toBeDefined();
        expect(sourceSandboxId).toBeDefined();
        if (snapshotId === undefined || sourceSandboxId === undefined) {
          return;
        }
        const restoreFromSnapshotId = snapshotId;
        const expectedSourceSandboxId = sourceSandboxId;

        const inspected = await client.getSnapshot(restoreFromSnapshotId);
        expect(inspected.snapshotId).toBe(restoreFromSnapshotId);
        expect(inspected.state).toBe("ready");
        expect(inspected.sourceSandboxId).toBe(expectedSourceSandboxId);

        const listed = await client.listSnapshots({ sourceSandboxId: expectedSourceSandboxId });
        expect(listed.some((row) => row.snapshotId === restoreFromSnapshotId)).toBe(true);

        await withDedicatedTaggedSandbox(
          client,
          {
            create: (tag) =>
              client.create({
                fileSystemSnapshot: {
                  mountPath: MOUNT_PATH,
                  restoreFromSnapshotId,
                },
                maxLifetimeSeconds: 600,
                tags: [tag],
              }),
            waitUntilRunning: true,
          },
          async (restored) => {
            console.log(`Started sandbox: ${restored.sandboxId}`);
            expect(restored.sandboxId).not.toBe(expectedSourceSandboxId);

            const read = await restored.exec(["cat", `${MOUNT_PATH}/data.txt`]);
            logProcessResult("restored scratch mount", read);
            expect(read.exitCode).toBe(0);
            expect(read.stdout).toContain(payload);
          },
        );

        await client.deleteSnapshot(snapshotId);
        await expect(
          client.deleteSnapshot(snapshotId, { missingOk: true }),
        ).resolves.toBeUndefined();
      } finally {
        await Promise.all(snapshotIds.map((id) => client.deleteSnapshot(id, { missingOk: true })));
      }
    },
    snapshotTimeoutMs,
  );
});
