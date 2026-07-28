<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: Apache-2.0
SPDX-PackageName: cwsandbox
-->

# AGENTS.md

## Project

This repository is the TypeScript SDK monorepo for CoreWeave Sandbox.

- Core SDK: `packages/cwsandbox` (`@coreweave/cwsandbox`)
- TanStack adapter: `packages/cwsandbox-tanstack` (`@coreweave/cwsandbox-tanstack`, private until fast-follow publish)
- Examples: `examples/sdk` (core recipes), `examples/weave`, `examples/tanstack` — see `examples/README.md` and `examples/AGENTS.md`
- Live e2e: `e2e/`

## Commands

- Install dependencies: `pnpm install`
- Check everything: `pnpm check`
- Fix lint/format issues: `pnpm fix`
- Format only: `pnpm format:fix`
- Test only: `pnpm test`
- Live e2e smoke: `pnpm smoke` (requires `CWSANDBOX_API_KEY`; not part of `pnpm check`)

## TypeScript Standards

- Keep `strict` TypeScript clean; do not use `any`.
- Prefer `unknown` for opaque external data.
- Use `readonly` for public option and result properties.
- Use string literal unions instead of enums.
- Public exported functions and methods should have explicit return types.
- Prefer named exports and explicit re-exports; do not use wildcard barrel exports.
- Use `.js` extensions in relative imports because this package uses `NodeNext` ESM.

## SDK Boundaries

- Keep `pnpm check` offline and credential-free.
- Do not add gRPC or proto dependencies unless explicitly working on transport.
- Keep generated/proto types out of public SDK signatures.
- Use SDK-owned public types from `packages/cwsandbox/src/public/`.
- Keep the root entrypoint transport-neutral; Node gRPC implementation code belongs under `packages/cwsandbox/src/transports/node-grpc`, while `packages/cwsandbox/src/node` is the public Node runtime subpath shim.
- Keep tests colocated next to source files.
- Use Oxc/Oxfmt for linting and formatting.
- Core and adapters share lockstep versions; first npm cut is core only.

## Documentation and Examples

- When adding, renaming, or changing public SDK options/methods, update `packages/cwsandbox/README.md` examples in the same change.
- Prefer adding or updating a runnable recipe under `examples/sdk/` for new workflows; keep scripts self-contained (no shared example `lib/`).
- Keep README TypeScript examples copy-pasteable and backend-valid.
- Run `pnpm test:readme` for README-only example changes, or `pnpm check` for normal changes (`pnpm check` includes `examples/sdk` typecheck).
- `pnpm test:readme` typechecks README `ts`/`typescript` code fences, so keep snippets valid even when they are illustrative.
- Root `README.md` is a short monorepo hub only.
