// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

interface CleanupOptions {
  readonly dryRun: boolean;
  readonly tag: string;
}

const options = parseArgs(process.argv.slice(2));
const client = createSandboxClientFromEnv();
let pageToken: string | undefined;
let cleaned = 0;

do {
  const result = await client.list({
    includeStopped: false,
    pageSize: 100,
    ...(pageToken === undefined ? {} : { pageToken }),
    tags: [options.tag],
  });

  for (const sandbox of result.sandboxes) {
    console.log(`${options.dryRun ? "would delete" : "deleting"} ${sandbox.sandboxId}`);
    if (!options.dryRun) {
      await client.delete(sandbox.sandboxId).catch(async () => {
        const attached = await client.fromId(sandbox.sandboxId);
        await attached.stop().catch(() => undefined);
      });
    }
    cleaned += 1;
  }

  pageToken = result.nextPageToken;
} while (pageToken !== undefined);

console.log(`${options.dryRun ? "found" : "cleaned"} ${cleaned} sandboxes for tag ${options.tag}`);

function parseArgs(args: readonly string[]): CleanupOptions {
  const tagIndex = args.indexOf("--tag");
  const tag = tagIndex === -1 ? undefined : args[tagIndex + 1];

  if (tag === undefined || tag.trim() === "") {
    throw new Error("Usage: pnpm smoke:stress -- --cleanup --tag <exact-stress-tag> [--dry-run]");
  }

  return {
    dryRun: args.includes("--dry-run"),
    tag,
  };
}
