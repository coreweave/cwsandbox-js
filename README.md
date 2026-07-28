<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: Apache-2.0
SPDX-PackageName: cwsandbox
-->

# CWSandbox JS

TypeScript SDK and ecosystem adapters for [CoreWeave Sandbox](https://docs.coreweave.com/products/coreweave-sandbox/client).

This is a pnpm monorepo. Product docs for the core SDK live in
[`packages/cwsandbox`](./packages/cwsandbox/README.md).

For contribution guidelines and CLA requirements, see
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Packages

| Package                                                          | Status                                          | Description                             |
| ---------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------- |
| [`@coreweave/cwsandbox`](./packages/cwsandbox)                   | `0.1.0-beta.0` (publish-ready)                  | Core TypeScript SDK (`/node`, `/wandb`) |
| [`@coreweave/cwsandbox-tanstack`](./packages/cwsandbox-tanstack) | same version, private until fast-follow publish | TanStack AI sandbox adapter             |
| Vercel AI adapter                                                | planned                                         | npm name deferred until scaffold        |

Versions are **lockstep**: core and adapters share the same version string when
published. First npm cut is core only; TanStack follows at the matching version.

## Develop

```bash
pnpm install
pnpm check
```

Useful commands:

- `pnpm build` — build `@coreweave/cwsandbox`
- `pnpm test` — unit tests for the core package
- `pnpm smoke` — live e2e smoke (`CWSANDBOX_API_KEY` required; not part of `pnpm check`)
- `pnpm --dir examples/sdk quick-start` — core SDK recipe (see [`examples/README.md`](./examples/README.md))
- `pnpm example:weave` / `pnpm example:tanstack` — integration examples

## Examples

Runnable recipes and integrations live under [`examples/`](./examples/). See
[`examples/README.md`](./examples/README.md) for the full gallery, deferred
Python-parity gaps, and how to run each script.

## License

- The CWSandbox SDK packages (`packages/*`) are licensed under the Apache-2.0 license.
- The usage examples (`examples/`) are licensed under the BSD-3-Clause license.
