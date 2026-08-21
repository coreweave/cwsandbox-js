<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: Apache-2.0
SPDX-PackageName: cwsandbox
-->

# CWSandbox TanStack Adapter

Experimental TanStack AI sandbox provider for CoreWeave Sandbox.

This package adapts `@coreweave/cwsandbox` to TanStack AI's `SandboxProvider`
contract so TanStack coding-agent middleware can create and use CoreWeave
Sandboxes.

## Install

```bash
pnpm add @coreweave/cwsandbox @coreweave/cwsandbox-tanstack @tanstack/ai-sandbox
```

`@tanstack/ai-sandbox` is a peer dependency so applications can choose their
TanStack AI version.

## Usage

```ts
import { defineSandbox } from "@tanstack/ai-sandbox";
import { cwsandboxTanStackProvider } from "@coreweave/cwsandbox-tanstack";

const sandbox = defineSandbox({
  id: "cwsandbox-agent",
  provider: cwsandboxTanStackProvider(),
});
```

By default, the provider reads `CWSANDBOX_API_KEY` and optional
`CWSANDBOX_BASE_URL` through `@coreweave/cwsandbox/node`.

## Current Capability Mapping

Supported in this first adapter:

- Create, resume, and destroy sandboxes.
- Blocking command execution through `handle.process.exec(...)`.
- Background command execution through `handle.process.spawn(...)`.
- Filesystem read/write plus shell-backed list, mkdir, remove, rename, and exists.
- Exec-backed git helpers from `@tanstack/ai-sandbox`.
- Per-create and per-command environment variables.

Explicitly unsupported for now:

- Port channels.
- Snapshots and restore.
- Fork.
- Network policy.
- Killable processes (`SpawnHandle.kill` aborts the client stream only).

Unsupported capabilities are advertised as `false` and throw TanStack's
`UnsupportedCapabilityError` if called.

## Development

```bash
pnpm --filter @coreweave/cwsandbox-tanstack test
CWSANDBOX_API_KEY=... pnpm smoke
CWSANDBOX_API_KEY=... pnpm --filter @coreweave/cwsandbox-tanstack smoke
```

Root `pnpm smoke` runs this adapter smoke with the rest of the live suite.
The package `smoke` script runs only this file. Both skip without
`CWSANDBOX_API_KEY` and are not part of `pnpm check`.

Live smoke (billable) covers:

- create with per-create / handle / process env merge
- `process.exec` with `cwd`
- filesystem mkdir / write / read / readBytes / list / exists / rename / remove
- `process.spawn` with stdin and `wait`
- `resume` by id
- destroy (`resume` of a missing id is `null` only on `NOT_FOUND`, unit-tested; GetSandbox still succeeds while terminating)

Git helpers are exec-backed and need `git` on the sandbox image; they are not
part of this smoke (default image is the core SDK `python:3.11`).

## License

This package is licensed under the Apache-2.0 license.
