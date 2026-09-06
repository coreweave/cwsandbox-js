// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { normalizeChangelog } from "./version-packages.js";

describe("version package changelog", () => {
  it("keeps the SPDX header and moves pending notes into the release", () => {
    const before = `<!--
SPDX-License-Identifier: BSD-3-Clause
-->

# Changelog

## Unreleased

- An existing pending change.

## 0.4.0-beta.0

- The previous release.
`;
    const generated = `<!--

## 0.4.0-beta.1

### Patch Changes

- A fixed bug.
SPDX-License-Identifier: BSD-3-Clause
-->

# Changelog

## Unreleased

- An existing pending change.

## 0.4.0-beta.0

- The previous release.
`;

    expect(normalizeChangelog(before, generated)).toBe(`<!--
SPDX-License-Identifier: BSD-3-Clause
-->

# Changelog

## Unreleased

## 0.4.0-beta.1

### Patch Changes

- A fixed bug.

- An existing pending change.

## 0.4.0-beta.0

- The previous release.
`);
  });
});
