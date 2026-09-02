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

## Availability

> npm publishing for this package is deferred. Until its first release, use it
> from this monorepo workspace or from a locally packed tarball.

After the initial release, install the adapter and its peer dependency with:

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

Live adapter smoke is `pnpm smoke` from the repo root (requires `CWSANDBOX_API_KEY`).

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

## License

This package is licensed under the Apache-2.0 license.
