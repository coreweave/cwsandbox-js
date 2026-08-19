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
  // ownerTag scopes list/destroy; auto-generated if omitted
});

const sandbox = await compute.sandbox.create({
  cpu: 8,
  memoryMiB: 16384,
  image: "ubuntu:24.04",
  name: "demo", // stored as annotation, not a tag
  timeout: 300_000, // maps to maxLifetimeSeconds (server TTL)
});

const result = await sandbox.runCommand("echo hello && uname -r", {
  cwd: "/tmp",
  env: { HELLO: "world" },
});
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
| `ownerTag`                       | auto 6-char `[a-z0-9]`      | paired with `computesdk` tag for list scoping; stable per config object |
| `runnerIds`                      | —                           | scheduling constraints                                                  |
| `client` / `createClient`        | —                           | inject a `SandboxClient` (tests / advanced); client factory is memoized |

Create options of note:

- `name` → sandbox annotation `name` (not a tag)
- `timeout` (ms) → `maxLifetimeSeconds` only (not create `timeoutMs`)
- `services` / `network` forwarded to the core SDK (requested at create; URL may appear after running)
- Tags always include `computesdk` + `ownerTag`

## Capability mapping

Supported:

- Create, getById, list (filtered to `computesdk` + `ownerTag`), and destroy
- Blocking command execution (`/usr/bin/env` + `/bin/sh -c`) and long-timeout
  streamed exec (`timeout > 240s` → SDK `commands.start`) with native `cwd`
- Native file read/write; `writeFile` creates parent directories first
- Shell-backed mkdir, portable `ls -la` readdir, exists, and remove
- Resource mapping from ComputeSDK `cpu` / `memoryMiB`
- `getInfo`: not-found → `stopped`; other inspect errors rethrown
- `getUrl({ port })` returns the assigned `serviceUrls` entry for that port
  (polls inspect up to 60s; assignment can lag `running`)

Explicitly unsupported for now:

- `getUrl` when create did not assign a `serviceUrls` entry for that port
- ComputeSDK `onStdout` / `onStderr` streaming (requires ComputeSDK's daemond
  path; `getUrl` alone does not enable callbacks)
- Templates and snapshots
- Returning remaining lifetime on discover (`timeout` on getInfo uses create-time TTL)

## Development

```bash
pnpm --filter @coreweave/cwsandbox-computesdk test
CWSANDBOX_API_KEY=... pnpm --filter @coreweave/cwsandbox-computesdk smoke
```

Live smoke (billable, not part of `pnpm check`) covers:

- create with resource knobs + name annotation
- short unary `runCommand`
- `cwd` / `env`
- long-timeout streamed exec (`timeout > 240s` → SDK `commands.start`)
- nested filesystem write/read + `readdir` (parent mkdir via adapter)
- `getInfo` status `running`
- `getUrl({ port })` after public HTTPS create (waits up to 60s for assignment)
- destroy

## License

This package is licensed under the Apache-2.0 license. See `LICENSE-Apache-2.0.txt`
and `NOTICE`.
