// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repoRoot, "packages", "cwsandbox");
const outputDir = join(repoRoot, ".package-consumers");
const packageLink = join("node_modules", "@coreweave", "cwsandbox");
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  version?: string;
};
const packageVersion = packageManifest.version;
if (packageVersion === undefined || packageVersion === "") {
  throw new Error(
    "packages/cwsandbox/package.json must declare version for package consumer tests.",
  );
}

describe("built package consumers", () => {
  it("typechecks an ESM TypeScript consumer through package exports", () => {
    assertBuiltPackage();
    const fixtureDir = createFixture("esm-typescript");
    writeProjectFile(
      fixtureDir,
      "index.ts",
      [
        'import { CWSandboxValidationError, DEFAULT_KEEP_ALIVE_COMMAND, type SandboxClient, type MountedFiles, type ResourceRequestsAndLimits } from "@coreweave/cwsandbox";',
        'import { DEFAULT_BASE_URL, DEFAULT_CONTAINER_IMAGE, createSandboxClient, type NodeSandboxClientOptions } from "@coreweave/cwsandbox/node";',
        'import { createSandboxClient as createWandbSubpathClient, type WandbSandboxClientOptions } from "@coreweave/cwsandbox/wandb";',
        "",
        "const mountedFiles: MountedFiles = {",
        '  "/workspace/main.py": "print(1)",',
        "};",
        "const resources: ResourceRequestsAndLimits = {",
        '  limits: { cpu: "2", memory: "2Gi" },',
        '  requests: { cpu: "1", memory: "1Gi" },',
        "};",
        'const options: NodeSandboxClientOptions = { apiKey: "token" };',
        'const wandbOptions: WandbSandboxClientOptions = { apiKey: "wandb-token" };',
        "const client: SandboxClient = createSandboxClient(options);",
        "const nodeClient = createSandboxClient(options);",
        "const wandbSubpathClient = createWandbSubpathClient(wandbOptions);",
        "const error = new CWSandboxValidationError(DEFAULT_BASE_URL);",
        "const command = DEFAULT_KEEP_ALIVE_COMMAND;",
        "const containerImage = DEFAULT_CONTAINER_IMAGE;",
        "",
        "void mountedFiles;",
        "void resources;",
        "void client;",
        "void nodeClient;",
        "void wandbSubpathClient;",
        "void error;",
        "void command;",
        "void containerImage;",
        "",
      ].join("\n"),
    );
    writeProjectFile(
      fixtureDir,
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            exactOptionalPropertyTypes: true,
            lib: ["ES2022"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: "ES2022",
            types: ["node"],
          },
          include: ["index.ts"],
        },
        null,
        2,
      ),
    );

    const result = spawnSync("pnpm", ["exec", "tsc", "--project", fixtureDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    if (result.status !== 0) {
      throw new Error(result.stdout + result.stderr);
    }

    expect(result.status).toBe(0);
  });

  it("runs an ESM JavaScript consumer through package exports", () => {
    assertBuiltPackage();
    const fixtureDir = createFixture("esm-javascript");
    writeProjectFile(
      fixtureDir,
      "index.mjs",
      [
        'import { strict as assert } from "node:assert";',
        'import { CWSandboxValidationError, DEFAULT_KEEP_ALIVE_COMMAND } from "@coreweave/cwsandbox";',
        'import { DEFAULT_BASE_URL, DEFAULT_CONTAINER_IMAGE } from "@coreweave/cwsandbox/node";',
        'import { toWandbMetadata } from "@coreweave/cwsandbox/wandb";',
        "",
        'assert.equal(DEFAULT_BASE_URL, "https://api.cwsandbox.com");',
        'assert.equal(DEFAULT_CONTAINER_IMAGE, "python:3.11");',
        'assert.deepEqual(DEFAULT_KEEP_ALIVE_COMMAND, ["/bin/sh", "-lc", "trap \'exit 0\' TERM INT; sleep infinity & wait"]);',
        'assert.equal(new CWSandboxValidationError("bad").code, "validation_error");',
        'assert.equal(toWandbMetadata({ apiKey: "wandb-token", env: {} })["x-wandb-api-key"], "wandb-token");',
        `assert.equal(toWandbMetadata({ apiKey: "wandb-token", env: {} })["x-cwsandbox-client-version"], ${JSON.stringify(packageVersion)});`,
        `assert.equal(toWandbMetadata({ apiKey: "wandb-token", env: {} })["x-wandb-sdk-version"], ${JSON.stringify(packageVersion)});`,
        'assert.equal(toWandbMetadata({ apiKey: "wandb-token", env: {} })["x-sandbox-integration"], "js-sdk");',
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [join(fixtureDir, "index.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    if (result.status !== 0) {
      throw new Error(result.stdout + result.stderr);
    }

    expect(result.status).toBe(0);
  });
});

function assertBuiltPackage(): void {
  for (const file of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/node/index.js",
    "dist/node/index.d.ts",
    "dist/wandb/index.js",
    "dist/wandb/index.d.ts",
  ]) {
    if (!existsSync(join(packageRoot, file))) {
      throw new Error(
        `Missing built package file ${file}. Run pnpm build before package consumer tests.`,
      );
    }
  }
}

function createFixture(name: string): string {
  const fixtureDir = join(outputDir, name);
  rmSync(fixtureDir, { force: true, recursive: true });
  mkdirSync(join(fixtureDir, "node_modules", "@coreweave"), { recursive: true });
  symlinkSync(packageRoot, join(fixtureDir, packageLink), "dir");
  writeProjectFile(fixtureDir, "package.json", JSON.stringify({ type: "module" }, null, 2));
  return fixtureDir;
}

function writeProjectFile(fixtureDir: string, filename: string, contents: string): void {
  writeFileSync(join(fixtureDir, filename), contents);
}
