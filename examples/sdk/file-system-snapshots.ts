// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * File-system snapshots — snapshot a scratch mount, restore it, then delete.
 *
 * Demonstrates:
 * - create({ fileSystemSnapshot }) with a workspace scratch mount
 * - sandbox.snapshot() waiting until READY (returns the Get record, not only the ID)
 * - client.getSnapshot / client.listSnapshots after the source sandbox is gone
 * - restore via restoreFromSnapshotId
 * - client.deleteSnapshot(snapshotId, { missingOk: true })
 *
 * Snapshots archive the scratch mount, not the whole container overlay.
 * FSS is gated per-organization; unsupported orgs raise CWSandboxNotImplementedError.
 */

import { CWSandboxNotImplementedError } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

const MOUNT_PATH = "/workspace";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();
  const snapshotIds: string[] = [];
  let snapshotId: string | undefined;

  try {
    const source = await client.create({
      fileSystemSnapshot: {
        mountPath: MOUNT_PATH,
        size: "1Gi",
      },
      tags: ["example-file-system-snapshots"],
    });

    try {
      await source.exec(["sh", "-c", `echo 'hello from source' > ${MOUNT_PATH}/data.txt`]);
      console.log(`Seeded ${MOUNT_PATH}/data.txt in source sandbox ${source.sandboxId}`);

      const snapshot = await source.snapshot();
      snapshotId = snapshot.snapshotId;
      snapshotIds.push(snapshot.snapshotId);
      console.log(
        `Created snapshot ${snapshot.snapshotId} state=${snapshot.state}${snapshot.sizeBytes === undefined ? "" : ` (${snapshot.sizeBytes} bytes)`}`,
      );
    } finally {
      await source.delete({ missingOk: true });
    }

    if (snapshotId === undefined) {
      return;
    }

    const inspected = await client.getSnapshot(snapshotId);
    const listed = await client.listSnapshots({ sourceSandboxId: inspected.sourceSandboxId });
    console.log(
      `Inspected snapshot ${inspected.snapshotId} state=${inspected.state}; list matched ${listed.filter((row) => row.snapshotId === snapshotId).length}`,
    );

    const restored = await client.create({
      fileSystemSnapshot: {
        mountPath: MOUNT_PATH,
        restoreFromSnapshotId: snapshotId,
      },
      tags: ["example-file-system-snapshots"],
    });

    try {
      const contents = await restored.exec(["cat", `${MOUNT_PATH}/data.txt`]);
      console.log(`Restored sandbox sees: ${JSON.stringify(contents.stdout.trim())}`);
    } finally {
      await restored.delete({ missingOk: true });
    }
  } catch (error) {
    if (error instanceof CWSandboxNotImplementedError) {
      console.log(
        "File-system snapshots are not enabled for this organization. Contact CoreWeave to enable FSS.",
      );
      return;
    }
    throw error;
  } finally {
    await Promise.all(
      snapshotIds.map((snapshotId) => client.deleteSnapshot(snapshotId, { missingOk: true })),
    );
  }
}

await main();
