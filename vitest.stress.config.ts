// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    fileParallelism: false,
    include: ["e2e/**/*.stress.e2e.test.ts"],
    testTimeout: 180_000,
  },
});
