<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: BSD-3-Clause
SPDX-PackageName: cwsandbox
-->

# Examples (agents)

Runnable examples for `@coreweave/cwsandbox`. Prefer `examples/sdk` recipes for core
SDK patterns; use `weave/` / `tanstack/` for integrations with extra dependencies.

## Layout

| Path        | Role                                        |
| ----------- | ------------------------------------------- |
| `sdk/*.ts`  | Self-contained SDK recipes (one focus each) |
| `weave/`    | Weave tracing integration package           |
| `tanstack/` | TanStack AI adapter integration package     |

## SDK scripts

| File                            | Entry                   | Description                    |
| ------------------------------- | ----------------------- | ------------------------------ |
| `sdk/quick-start.ts`            | `async function main()` | `withSandbox` + `commands.run` |
| `sdk/basic-execution.ts`        | `async function main()` | commands + files               |
| `sdk/streaming-exec.ts`         | `async function main()` | streaming stdout               |
| `sdk/stdin-streaming.ts`        | `async function main()` | stdin writer                   |
| `sdk/large-file-streaming.ts`   | `async function main()` | file streams                   |
| `sdk/resource-configuration.ts` | `async function main()` | resources                      |
| `sdk/error-handling.ts`         | `async function main()` | typed errors                   |
| `sdk/reconnect-to-sandbox.ts`   | CLI flags               | `fromId`                       |
| `sdk/delete-sandboxes.ts`       | `async function main()` | delete / missingOk             |
| `sdk/cleanup-by-tag.ts`         | CLI flags               | tag cleanup                    |
| `sdk/cleanup-old-sandboxes.ts`  | CLI flags               | age cleanup                    |
| `sdk/list-stopped-sandboxes.ts` | CLI flags               | showTerminated                 |
| `sdk/multiple-sandboxes.ts`     | `async function main()` | parallel sandboxes             |
| `sdk/parallel-batch-job.ts`     | `async function main()` | batch jobs                     |
| `sdk/interactive-streaming.ts`  | `async function main()` | log follow                     |
| `sdk/wandb-integration.ts`      | `async function main()` | W&B gateway auth               |
| `sdk/file-system-snapshots.ts`  | `async function main()` | scratch-mount snapshot/restore |
| `sdk/run-from-template.ts`      | `async function main()` | `withSandboxFromTemplate`      |
| `sdk/https-endpoint.ts`         | `async function main()` | public HTTPS + request timeout |

## Running

```bash
export CWSANDBOX_API_KEY="..."
pnpm --dir examples/sdk quick-start
pnpm --dir examples/sdk typecheck
```

## Writing new SDK examples

- **Single focus**, self-contained (no shared `lib/`)
- SPDX BSD-3-Clause + `SPDX-PackageName: cwsandbox`
- Prefer `createSandboxClientFromEnv` from `@coreweave/cwsandbox/node`
- Use stable tags like `example-<name>` for cleanup demos
- Prefer `missingOk: true` on cleanup paths
- Do not add examples for deferred APIs listed in `README.md` until the SDK supports them

### Template

```ts
// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Short description.
 *
 * Demonstrates:
 * - Key concept
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();
  await client.withSandbox(
    async (sandbox) => {
      const result = await sandbox.commands.run(["echo", "hello"]);
      console.log(result.stdout.trimEnd());
    },
    { tags: ["example", "example-your-name"] },
  );
}

await main();
```
