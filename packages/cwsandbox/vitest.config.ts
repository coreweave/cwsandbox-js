// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "e2e/**", "node_modules/**"],
    include: ["src/**/*.test.ts"],
    typecheck: {
      include: ["src/**/*.test-d.ts"],
    },
  },
});
