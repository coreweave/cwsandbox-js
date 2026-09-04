<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: Apache-2.0
SPDX-PackageName: cwsandbox
-->

# Changesets

User-visible changes to `@coreweave/cwsandbox` need a changeset. Run
`pnpm changeset`, select the core package, and choose:

- `minor` for a feature or breaking beta API change;
- `patch` for a compatible fix.

Write the summary for SDK users. Documentation, tests, examples, and internal
refactors do not need a changeset unless they alter the published package.

The release workflow collects these files into a version pull request. Do not edit
package versions manually. ComputeSDK and TanStack adapters are deliberately ignored
until their separate publishing-readiness reviews are complete.
