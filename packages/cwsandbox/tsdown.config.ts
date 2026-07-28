// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { defineConfig } from "tsdown";

import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "node/index": "src/node/index.ts",
    "wandb/index": "src/wandb/index.ts",
  },
  // platform:node defaults fixedExtension:true (.mjs/.d.mts); keep .js/.d.ts for package exports.
  fixedExtension: false,
  format: ["esm"],
  platform: "node",
  sourcemap: true,
  target: "node22",
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  deps: {
    neverBundle: true,
  },
});
