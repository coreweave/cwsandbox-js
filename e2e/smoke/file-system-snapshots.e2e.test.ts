// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

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
      const snapshotIds: string[] = [];

      try {
        let snapshotId: string | undefined;

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
            const write = await source.exec([
              "sh",
              "-c",
              `echo 'hello from snapshot smoke' > ${MOUNT_PATH}/data.txt`,
            ]);
            logProcessResult("seed scratch mount", write);
            expect(write.exitCode).toBe(0);

            const snapshot = await source.snapshot();
            snapshotId = snapshot.snapshotId;
            snapshotIds.push(snapshot.snapshotId);
            expect(snapshot.snapshotId).toMatch(/\S/);
            console.log("created snapshot", {
              snapshotId: snapshot.snapshotId,
              sizeBytes: snapshot.sizeBytes,
            });
          },
        );

        expect(snapshotId).toBeDefined();
        if (snapshotId === undefined) {
          return;
        }
        const restoreFromSnapshotId = snapshotId;

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
            const read = await restored.exec(["cat", `${MOUNT_PATH}/data.txt`]);
            logProcessResult("restored scratch mount", read);
            expect(read.exitCode).toBe(0);
            expect(read.stdout).toContain("hello from snapshot smoke");
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
