<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: Apache-2.0
SPDX-PackageName: cwsandbox
-->

# CWSandbox ComputeSDK Provider

[ComputeSDK](https://www.computesdk.com/) provider for CoreWeave Sandbox.

This package adapts [`@coreweave/cwsandbox`](../cwsandbox) to ComputeSDK's
`defineProvider` contract (`create` / `getById` / `list` / `destroy` /
`runCommand` / filesystem helpers).

## Install

```bash
pnpm add @coreweave/cwsandbox @coreweave/cwsandbox-computesdk @computesdk/provider
```

`@computesdk/provider` is a peer dependency so applications can choose their
ComputeSDK version.

> npm publish for this package is deferred; until then, install from the monorepo
> workspace or a packed tarball.

## Usage

```ts
import { coreweave } from "@coreweave/cwsandbox-computesdk";

const compute = coreweave({
  // apiKey defaults to process.env.CWSANDBOX_API_KEY
  // baseUrl defaults to https://api.cwsandbox.com
});

const sandbox = await compute.sandbox.create({
  cpu: 8,
  memoryMiB: 16384,
  image: "ubuntu:24.04",
});

const result = await sandbox.runCommand("echo hello && uname -r");
console.log(result.stdout);

await sandbox.destroy();
```

## Configuration

| Config / env                     | Default                     | Notes                                                                   |
| -------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `apiKey` / `CWSANDBOX_API_KEY`   | —                           | required unless `client` / `createClient` is set                        |
| `baseUrl` / `CWSANDBOX_BASE_URL` | `https://api.cwsandbox.com` |                                                                         |
| `image`                          | `ubuntu:24.04`              | OCI image for new sandboxes                                             |
| `cpu` / `memory`                 | `2` / `4Gi`                 | Kubernetes quantities (defaults; per-create `cpu`/`memoryMiB` override) |
| `maxLifetimeSeconds`             | `3600`                      | server-enforced hard TTL                                                |
| `runnerIds` / `profileNames`     | —                           | scheduling constraints                                                  |
| `client` / `createClient`        | —                           | inject a `SandboxClient` (tests / advanced)                             |

## Capability mapping

Supported:

- Create, getById, list, and destroy
- Blocking command execution and long-timeout streamed exec via the CoreWeave SDK
- Native file read/write via the CoreWeave SDK
- Shell-backed mkdir, readdir, exists, and remove
- Resource mapping from ComputeSDK `cpu` / `memoryMiB`

Explicitly unsupported for now:

- `getUrl` (port exposure helper)
- ComputeSDK `onStdout` / `onStderr` callbacks (ComputeSDK routes these through
  daemond + `getUrl`; blocked until `getUrl` exists)
- Templates and snapshots

## Development

```bash
pnpm --filter @coreweave/cwsandbox-computesdk test
CWSANDBOX_API_KEY=... pnpm --filter @coreweave/cwsandbox-computesdk smoke
```

## License

This package is licensed under the Apache-2.0 license.
