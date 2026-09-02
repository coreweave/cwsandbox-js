<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: BSD-3-Clause
SPDX-PackageName: cwsandbox
-->

# TanStack Sandbox Adapter Example

Exercise the experimental `@coreweave/cwsandbox-tanstack` package with
TanStack AI's sandbox definition API.

The example:

1. Creates a TanStack `defineSandbox(...)` definition with the CoreWeave Sandbox
   provider.
2. Exports the matching `withSandbox(...)` middleware for chat integrations.
3. Creates a tiny Python workspace through the TanStack `SandboxHandle` file API.
4. Runs a deterministic test command through `handle.process.exec(...)`.
5. Reads generated output back from the sandbox and prints provider capabilities.
6. Destroys the live sandbox before exiting.

## Prerequisites

Set CoreWeave Sandbox credentials:

```bash
export CWSANDBOX_API_KEY="..."
export CWSANDBOX_BASE_URL="https://api.cwsandbox.com" # Optional.
```

No LLM API key is required for this example.

## Run

From the repository root:

```bash
pnpm install
pnpm --dir examples/tanstack start
```

## Typecheck Without Running

```bash
pnpm --dir examples/tanstack typecheck
```

## Notes

The runnable path calls `tanstackSandbox.ensure(...)` directly so it can validate
the provider without a model adapter. It intentionally exercises the same
`SandboxHandle` surface a TanStack coding-agent harness would use: filesystem,
command execution, provider capabilities, and cleanup. Real TanStack AI chat
usage should pass the exported `tanstackSandboxMiddleware` into
`chat({ middleware: [...] })`.
