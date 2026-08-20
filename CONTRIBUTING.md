<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: Apache-2.0
SPDX-PackageName: cwsandbox
-->

# Contributing to CWSandbox JS

This document uses [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt) keywords: MUST, SHOULD, MAY, etc.

## Setup

```bash
pnpm install
pnpm check
```

Useful commands:

- `pnpm build` — build all workspace packages with a `build` script (Turbo)
- `pnpm typecheck` / `pnpm test` — typecheck/test across the workspace graph (TypeScript 7.x native `tsc`)
- `pnpm quality` / `pnpm fix` — Oxlint + Oxfmt + Knip (check) / Oxlint + Oxfmt (fix)
- `pnpm smoke` — live e2e smoke (`CWSANDBOX_API_KEY` required; not part of `pnpm check`)

---

## Code

Code MUST be correct, minimal, and readable. Code SHOULD match existing conventions.

**Heuristic**: If you can't justify why a line exists, remove it.

Red flags:

- Abstractions used only once
- Comments describing what code does
- Speculative features

---

## Comments

Comments SHOULD explain _why_, not _what_. Comments MUST NOT duplicate what code already conveys.

**Heuristic**: If code is unclear without a comment, improve the code first. Use comments only when the reasoning isn't obvious from well-written code.

---

## Tests

Tests MUST be included with implementation. Tests MUST exercise YOUR code, not library behavior.

**Heuristic**: Each test should cover a unique code path. If two tests exercise the same logic, one is redundant.

Structure:

- Unit tests: package `vitest` configs under `packages/*`
- Live smoke / e2e: root `pnpm smoke` (credential-gated)

---

## Documentation

Public APIs MUST have clear TypeScript types and JSDoc where behavior is non-obvious. Documentation MUST be updated with code changes.

Product docs for the core SDK live in [`packages/cwsandbox/README.md`](./packages/cwsandbox/README.md).

---

## Commits

Each commit MUST:

- Include implementation, tests, and docs together when they are part of the same change
- Leave the codebase in a working state
- Pass `pnpm check` for offline work

**Heuristic**: One logical change per commit. If you use "and" in the message, consider splitting.

---

## Contributor License Agreement

Contributors must agree to the [CoreWeave CLA](./CLA.md) when pushing code to this project.

Agreement with the CoreWeave CLA must be signified by including a `Signed-Off-By`
trailer in every submitted Git commit to this repository. By signing off, you certify that you have the right to submit the contribution and that you agree to and are bound by the CoreWeave Contributor License Agreement in effect at the date of your submission, found in [`CLA.md`](./CLA.md), which governs your submission. If you are contributing on behalf of an entity, you further certify that you are authorized to bind that entity to the CLA.

Individual commits can be signed using the
`--signoff` option to [`git
commit`](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt---signoff); or a repo as a whole can use the `commit.signoff` configuration option.

---

## License headers

<!--- REUSE-IgnoreStart -->

Source code should contain an SPDX-style license header, reflecting:

- Year & Copyright owner
- SPDX License identifier `SPDX-License-Identifier: Apache-2.0` or
  `SPDX-License-Identifier: BSD-3-Clause` for examples.
- Package Name: `SPDX-PackageName: cwsandbox`

This can be partially automated with [FSFe REUSE](https://reuse.software/dev/#tool):

```shell
reuse annotate --license Apache-2.0 --copyright 'CoreWeave, Inc.' --year 2026 --template default_template --skip-existing $FILE
```

Blindly adding the headers to every file without review risks assigning the
wrong copyright owner! You should endeavor to understand who owns
contributions!

- The CWSandbox SDK packages (`packages/*`), tests, e2e, and scripts are licensed under the Apache-2.0 license
  to protect the rights of all parties.
- The CWSandbox usage examples (`examples/` directory) are licensed with
  the [BSD-3-Clause license](https://spdx.org/licenses/BSD-3-Clause.html) to encourage usage of the CWSandbox SDK, while
  protecting CoreWeave's trademarks & name.

Licensing state & SPDX bill-of-materials (BOM) can be validated & generated with:

```shell
reuse lint
reuse spdx
```

<!--- REUSE-IgnoreEnd -->
