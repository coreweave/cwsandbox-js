// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { defineConfig } from "tsup";

import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    index: "src/index.ts",
    "node/index": "src/node/index.ts",
    "wandb/index": "src/wandb/index.ts",
  },
  splitting: true,
  format: ["esm"],
  platform: "node",
  sourcemap: true,
  target: "node22",
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
