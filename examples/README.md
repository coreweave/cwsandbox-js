<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: BSD-3-Clause
SPDX-PackageName: cwsandbox
-->

# CWSandbox JS Examples

Runnable examples for `@coreweave/cwsandbox`, aligned with the Python
[`cwsandbox-client` examples](https://github.com/coreweave/cwsandbox-client/tree/main/examples)
where the JS SDK already supports the same capabilities.

## Prerequisites

```bash
# From the monorepo root
pnpm install
pnpm build

export CWSANDBOX_API_KEY="..."
# optional:
# export CWSANDBOX_BASE_URL="https://api.cwsandbox.com"
```

For `sdk/wandb-integration.ts` and `weave/`, use W&B credentials instead (or in addition):

```bash
export WANDB_API_KEY="..."
```

## SDK recipes (`examples/sdk`)

One workspace package with self-contained scripts (same deps). Typecheck is part of
`pnpm check`; live runs are manual.

| Script                      | Demonstrates                            | Run (from repo root)                                         |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| `quick-start.ts`            | `withSandbox` + `commands.run`          | `pnpm --dir examples/sdk quick-start`                        |
| `basic-execution.ts`        | commands + files                        | `pnpm --dir examples/sdk basic-execution`                    |
| `streaming-exec.ts`         | `commands.start` stdout stream          | `pnpm --dir examples/sdk streaming-exec`                     |
| `stdin-streaming.ts`        | stdin writer                            | `pnpm --dir examples/sdk stdin-streaming`                    |
| `large-file-streaming.ts`   | `files.writeStream` / `readStream`      | `pnpm --dir examples/sdk large-file-streaming`               |
| `resource-configuration.ts` | flat + requests/limits resources        | `pnpm --dir examples/sdk resource-configuration`             |
| `error-handling.ts`         | execution / not-found errors            | `pnpm --dir examples/sdk error-handling`                     |
| `reconnect-to-sandbox.ts`   | `create` + `fromId`                     | `pnpm --dir examples/sdk reconnect-to-sandbox -- --create`   |
| `delete-sandboxes.ts`       | `delete` / `missingOk` / `stop`         | `pnpm --dir examples/sdk delete-sandboxes`                   |
| `cleanup-by-tag.ts`         | `listAll` + tag cleanup                 | `pnpm --dir examples/sdk cleanup-by-tag -- --create`         |
| `cleanup-old-sandboxes.ts`  | age filter on `startedAt`               | `pnpm --dir examples/sdk cleanup-old-sandboxes -- --dry-run` |
| `list-stopped-sandboxes.ts` | `showTerminated`                        | `pnpm --dir examples/sdk list-stopped-sandboxes -- --create` |
| `multiple-sandboxes.ts`     | parallel sandboxes (no Session)         | `pnpm --dir examples/sdk multiple-sandboxes`                 |
| `parallel-batch-job.ts`     | batch `Promise` fan-out                 | `pnpm --dir examples/sdk parallel-batch-job`                 |
| `interactive-streaming.ts`  | `run` + log follow                      | `pnpm --dir examples/sdk interactive-streaming`              |
| `wandb-integration.ts`      | `@coreweave/cwsandbox/wandb` auth       | `pnpm --dir examples/sdk wandb-integration`                  |
| `file-system-snapshots.ts`  | scratch-mount snapshot / restore        | `pnpm --dir examples/sdk file-system-snapshots`              |
| `data-plane-mode.ts`        | `dataPlaneMode` auto / direct / gateway | `pnpm --dir examples/sdk data-plane-mode`                    |

Typecheck (also covered by root `pnpm check`):

```bash
pnpm --dir examples/sdk typecheck
```

## Integrations

| Package                   | Demonstrates                       | Run                     |
| ------------------------- | ---------------------------------- | ----------------------- |
| [`weave/`](./weave)       | Weave tracing of a sandbox command | `pnpm example:weave`    |
| [`tanstack/`](./tanstack) | TanStack AI sandbox adapter        | `pnpm example:tanstack` |

## Not yet available

These Python examples (or start options) are not matched in JS yet. Listed here for a
later issue-filing pass — do not add stub scripts until the SDK surface exists.

| Deferred              | Python analog                                                        | Notes                                |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| Discovery             | `discover_infrastructure.py`                                         | runners / profiles                   |
| Session multi-sandbox | `session_adopt_orphans.py`, Session usage in `multiple_sandboxes.py` | JS uses client + tags today          |
| RemoteFunction        | `function_decorator.py`                                              | `@session.function()`                |
| S3 mounts             | Python `s3_mount` start option                                       |                                      |
| CLI                   | Python CLI entrypoints                                               |                                      |
| App demos             | `swebench/`, `rl_training/`                                          | optional later, not core SDK surface |

N/A for JS (already async): Python `async_patterns.py`.

Related open issue (wait behavior): [#21](https://github.com/coreweave/cwsandbox-js/issues/21).

## License

Examples are licensed under the BSD-3-Clause license.
