// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repoRoot, "packages", "cwsandbox");
const outputDir = join(repoRoot, ".package-consumers");
const packageLink = join("node_modules", "@coreweave", "cwsandbox");

describe("built package consumers", () => {
  it("typechecks an ESM TypeScript consumer through package exports", () => {
    assertBuiltPackage();
    const fixtureDir = createFixture("esm-typescript");
    writeProjectFile(
      fixtureDir,
      "index.ts",
      [
        'import { CWSandboxValidationError, DEFAULT_KEEP_ALIVE_COMMAND, SandboxClient, type MountedFiles, type ResourceRequestsAndLimits, type SandboxTransport } from "@coreweave/cwsandbox";',
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
        "const client = new SandboxClient({ transport: {} as SandboxTransport });",
        "const nodeClient = createSandboxClient(options);",
        "const wandbSubpathClient = createWandbSubpathClient(wandbOptions);",
        "const error = new CWSandboxValidationError(DEFAULT_BASE_URL);",
        "const command = DEFAULT_KEEP_ALIVE_COMMAND;",
        "const containerImage = DEFAULT_CONTAINER_IMAGE;",
        "const createPromise = client.create({ waitUntilRunning: false });",
        "",
        "void mountedFiles;",
        "void resources;",
        "void client;",
        "void nodeClient;",
        "void wandbSubpathClient;",
        "void error;",
        "void command;",
        "void containerImage;",
        "void createPromise;",
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
        'import { CWSandboxValidationError, DEFAULT_KEEP_ALIVE_COMMAND, SandboxClient } from "@coreweave/cwsandbox";',
        'import { DEFAULT_BASE_URL, DEFAULT_CONTAINER_IMAGE } from "@coreweave/cwsandbox/node";',
        'import { toWandbMetadata } from "@coreweave/cwsandbox/wandb";',
        "",
        "const client = new SandboxClient({",
        "  transport: {",
        "    async delete() {},",
        "    async exec(request) {",
        "      return {",
        "        command: request.command,",
        "        exitCode: 0,",
        "        failed: false,",
        "        ok: true,",
        '        stderr: "",',
        "        stderrBytes: new Uint8Array(),",
        "        stderrBytesProduced: 0,",
        "        stderrTruncated: false,",
        '        stdout: "",',
        "        stdoutBytes: new Uint8Array(),",
        "        stdoutBytesProduced: 0,",
        "        stdoutTruncated: false,",
        "      };",
        "    },",
        '    async get(request) { return { sandboxId: request.sandboxId, status: "running" }; },',
        "    async list() { return { sandboxes: [] }; },",
        "    async readFile() { return { content: new Uint8Array() }; },",
        '    async start(request) { return { sandboxId: request.command[0], status: "running" }; },',
        '    async startCommand() { throw new Error("not used"); },',
        "    async stop() {},",
        '    async streamLogs() { throw new Error("not used"); },',
        "    async writeFile() {},",
        "  },",
        "});",
        "",
        'assert.equal(DEFAULT_BASE_URL, "https://api.cwsandbox.com");',
        'assert.equal(DEFAULT_CONTAINER_IMAGE, "python:3.11");',
        'assert.deepEqual(DEFAULT_KEEP_ALIVE_COMMAND, ["/bin/sh", "-lc", "trap \'exit 0\' TERM INT; sleep infinity & wait"]);',
        "assert.equal(client instanceof SandboxClient, true);",
        'assert.equal((await client.create({ waitUntilRunning: false })).sandboxId, "/bin/sh");',
        'assert.equal(new CWSandboxValidationError("bad").code, "validation_error");',
        'assert.equal(toWandbMetadata({ apiKey: "wandb-token", env: {} })["x-wandb-api-key"], "wandb-token");',
        'assert.equal(toWandbMetadata({ apiKey: "wandb-token", env: {} })["x-cwsandbox-client-version"], "0.1.0-beta.0");',
        'assert.equal(toWandbMetadata({ apiKey: "wandb-token", env: {} })["x-wandb-sdk-version"], "0.1.0-beta.0");',
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
