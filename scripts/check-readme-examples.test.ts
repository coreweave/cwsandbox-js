// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface ReadmeExample {
  readonly code: string;
  readonly index: number;
  readonly line: number;
  readonly name: string;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repoRoot, "packages", "cwsandbox");
const readmePath = join(packageRoot, "README.md");
const outputDir = join(repoRoot, ".readme-examples");
const codeFencePattern = /```(?:ts|typescript)\n([\s\S]*?)```/g;

describe("README TypeScript examples", () => {
  const examples = readmeExamples();

  it("contains TypeScript examples", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)("$name", (example) => {
    const exampleDir = join(outputDir, `example-${example.index}`);

    rmSync(exampleDir, { force: true, recursive: true });
    mkdirSync(exampleDir, { recursive: true });
    writeExampleProject(exampleDir, example.code);

    const result = spawnSync("pnpm", ["exec", "tsc", "--noEmit", "--project", exampleDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    if (result.status !== 0) {
      throw new Error(result.stdout + result.stderr);
    }

    expect(result.status).toBe(0);
  });
});

function readmeExamples(): readonly ReadmeExample[] {
  const readme = readFileSync(readmePath, "utf8");

  return [...readme.matchAll(codeFencePattern)].map((match, index) => {
    const line = lineNumberAt(readme, match.index ?? 0);
    const section = nearestHeadingBefore(readme, match.index ?? 0);

    return {
      code: match[1] ?? "",
      index: index + 1,
      line,
      name: `${section} example at README line ${line}`,
    };
  });
}

function lineNumberAt(value: string, offset: number): number {
  return value.slice(0, offset).split("\n").length;
}

function nearestHeadingBefore(value: string, offset: number): string {
  const headings = value
    .slice(0, offset)
    .split("\n")
    .filter((line) => line.startsWith("#"));
  const heading = headings.at(-1);

  return heading?.replace(/^#+\s*/, "") ?? "README";
}

function toTypecheckableModule(example: string): string {
  const importLines: string[] = [];
  const bodyLines: string[] = [];

  for (const line of example.split("\n")) {
    if (line.startsWith("import ")) {
      importLines.push(rewritePackageImport(line));
      continue;
    }

    bodyLines.push(line);
  }

  return [
    'import type { Sandbox as ReadmeSandbox, SandboxClient as ReadmeSandboxClient } from "../../packages/cwsandbox/src/index.js";',
    "declare const client: ReadmeSandboxClient;",
    "declare const sandbox: ReadmeSandbox;",
    ...importLines,
    "",
    "async function readmeExample(): Promise<void> {",
    indent(bodyLines.join("\n").trimEnd()),
    "}",
    "",
    "void readmeExample;",
    "",
  ].join("\n");
}

function rewritePackageImport(line: string): string {
  return line
    .replaceAll('"@coreweave/cwsandbox/node"', '"../../packages/cwsandbox/src/node/index.js"')
    .replaceAll('"@coreweave/cwsandbox/wandb"', '"../../packages/cwsandbox/src/wandb/index.js"')
    .replaceAll('"@coreweave/cwsandbox"', '"../../packages/cwsandbox/src/index.js"');
}

function writeExampleProject(exampleDir: string, example: string): void {
  writeFileSync(
    join(exampleDir, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "../../packages/cwsandbox/tsconfig.json",
        include: ["example.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(exampleDir, "example.ts"), toTypecheckableModule(example));
}

function indent(value: string): string {
  if (value === "") {
    return "";
  }

  return value
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
}
