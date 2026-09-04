// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    include: [
      "scripts/check-package-consumers.test.ts",
      "scripts/publish-release.test.ts",
      "scripts/release-provenance.test.ts",
      "scripts/version-packages.test.ts",
    ],
    testTimeout: 30_000,
  },
});
