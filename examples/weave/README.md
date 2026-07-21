<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: BSD-3-Clause
SPDX-PackageName: cwsandbox
-->

# Weave Hello World

Trace a tiny CoreWeave Sandbox workflow with the Weave TypeScript SDK.

The example starts a sandbox, runs:

```bash
python -c "print('hello world from cwsandbox')"
```

and returns the command result from a `weave.op(...)` so the execution is visible in Weave.
The traced result includes the sandbox ID and a `weave-hello-*` sandbox tag so you can connect
the Weave trace back to the live sandbox metadata.

## Prerequisites

Set CoreWeave Sandbox credentials:

```bash
export CWSANDBOX_API_KEY="..."
```

Set Weave/W&B credentials with either `WANDB_API_KEY` or a W&B `.netrc` login:

```bash
export WANDB_API_KEY="..."
export WEAVE_PROJECT="my-team/cwsandbox-js-weave-example" # Optional.
```

If `WEAVE_PROJECT` is not set, the example uses `cwsandbox-js-weave-example`.

## Run

From the repository root:

```bash
pnpm install
pnpm --dir examples/weave start
```

## Typecheck Without Running

```bash
pnpm --dir examples/weave typecheck
```

## Notes

This example is an ESM TypeScript project. The `start` script builds TypeScript first, then runs Node with:

```bash
node --import=weave/instrument dist/index.js
```

The `--import=weave/instrument` flag lets Weave preload automatic instrumentation before application modules run.
