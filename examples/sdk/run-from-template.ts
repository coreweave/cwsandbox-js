// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Create a sandbox from an organization template.
 *
 * Demonstrates:
 * - withSandboxFromTemplate() for short-lived work and cleanup
 * - runFromTemplate() with await using for a direct handle with scoped cleanup
 *
 * Requires CWSANDBOX_TEMPLATE_ID or a template id as argv[2].
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const templateId = process.env["CWSANDBOX_TEMPLATE_ID"]?.trim() || process.argv[2]?.trim();
  if (templateId === undefined || templateId === "") {
    throw new Error("Set CWSANDBOX_TEMPLATE_ID or pass a template id as the first argument.");
  }

  const client = createSandboxClientFromEnv();

  const inherited = await client.withSandboxFromTemplate(
    templateId,
    async (sandbox) => sandbox.sandboxId,
    { tags: ["example", "example-run-from-template"] },
  );
  console.log(`Inherited sandbox: ${inherited}`);

  await using replaced = await client.runFromTemplate(templateId, {
    command: ["/bin/sh", "-c", "echo ready"],
    containerImage: "python:3.11",
    tags: ["example", "example-run-from-template"],
  });
  console.log(`Replaced sandbox: ${replaced.sandboxId}`);
}

await main();
