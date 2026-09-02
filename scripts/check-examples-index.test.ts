// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const examplesRoot = join(repoRoot, "examples");
const sdkRoot = join(examplesRoot, "sdk");
const manifest = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as PackageManifest;
const scripts = Object.keys(manifest.scripts ?? {}).filter((script) => script !== "typecheck");
const sourceFiles = readdirSync(sdkRoot)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => file.slice(0, -".ts".length));
const index = readFileSync(join(examplesRoot, "README.md"), "utf8");

describe("SDK examples index", () => {
  it.each(sourceFiles)("$0.ts has a runnable package script", (example) => {
    expect(scripts).toContain(example);
  });

  it.each(scripts)("$0 has a matching source file", (script) => {
    expect(sourceFiles).toContain(script);
  });

  it.each(scripts)("$0 is documented in the examples index", (script) => {
    expect(index).toContain(`pnpm --dir examples/sdk ${script}`);
  });
});
