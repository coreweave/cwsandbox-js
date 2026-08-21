// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "e2e/**/*.stress.e2e.test.ts", "node_modules/**"],
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 120_000,
  },
});
