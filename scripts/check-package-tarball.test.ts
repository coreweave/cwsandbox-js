// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repoRoot, "packages", "cwsandbox");
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  devDependencies?: {
    typescript?: string;
    "@types/node"?: string;
  };
};

const requiredPackedPaths = [
  "package/package.json",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/node/index.js",
  "package/dist/node/index.d.ts",
  "package/dist/wandb/index.js",
  "package/dist/wandb/index.d.ts",
];

const forbiddenPackedPathPatterns = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)src\//,
  /\.test\.tsx?$/,
  /\.test-d\.ts$/,
  /\/__tests__\//,
  /\/vitest\.config\./,
];

describe("packed package consumers", () => {
  it(
    "installs the pnpm pack tarball, typechecks, and imports public entrypoints",
    { timeout: 120_000 },
    () => {
      assertBuiltPackage();

      const packDir = mkdtempSync(join(tmpdir(), "cwsandbox-pack-"));
      const fixtureDir = mkdtempSync(join(tmpdir(), "cwsandbox-consumer-"));

      try {
        const tarballPath = packPackage(packDir);
        assertTarballHygiene(tarballPath);

        const typescript = packageManifest.devDependencies?.typescript;
        const typesNode = packageManifest.devDependencies?.["@types/node"];
        if (typescript === undefined || typesNode === undefined) {
          throw new Error(
            "packages/cwsandbox/package.json must declare typescript and @types/node devDependencies for the pack consumer fixture.",
          );
        }

        writeProjectFile(
          fixtureDir,
          "package.json",
          JSON.stringify(
            {
              name: "cwsandbox-tarball-consumer",
              private: true,
              type: "module",
              devDependencies: {
                typescript,
                "@types/node": typesNode,
              },
            },
            null,
            2,
          ),
        );

        const install = spawnSync("npm", ["install", tarballPath], {
          cwd: fixtureDir,
          encoding: "utf8",
          env: {
            ...process.env,
            // Keep npm cache inside the fixture so CI/sandbox runs do not depend
            // on a writable ~/.npm directory.
            npm_config_cache: join(fixtureDir, ".npm-cache"),
          },
        });
        if (install.status !== 0) {
          throw new Error(install.stdout + install.stderr);
        }

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

        const tscBin = join(
          fixtureDir,
          "node_modules",
          ".bin",
          process.platform === "win32" ? "tsc.cmd" : "tsc",
        );
        if (!existsSync(tscBin)) {
          throw new Error(`Expected fixture-local tsc at ${tscBin} after npm install.`);
        }

        const typecheck = spawnSync(tscBin, ["--project", fixtureDir], {
          cwd: fixtureDir,
          encoding: "utf8",
        });
        if (typecheck.status !== 0) {
          throw new Error(typecheck.stdout + typecheck.stderr);
        }
        expect(typecheck.status).toBe(0);

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

        const run = spawnSync(process.execPath, [join(fixtureDir, "index.mjs")], {
          cwd: fixtureDir,
          encoding: "utf8",
        });
        if (run.status !== 0) {
          throw new Error(run.stdout + run.stderr);
        }
        expect(run.status).toBe(0);
      } finally {
        rmSync(fixtureDir, { force: true, recursive: true });
        rmSync(packDir, { force: true, recursive: true });
      }
    },
  );
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

function packPackage(packDir: string): string {
  const pack = spawnSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (pack.status !== 0) {
    throw new Error(pack.stdout + pack.stderr);
  }

  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected one tarball in ${packDir}, found ${tarballs.length}: ${tarballs.join(", ") || "<none>"}\n${pack.stdout}\n${pack.stderr}`,
    );
  }

  const tarballName = tarballs[0];
  if (tarballName === undefined) {
    throw new Error(`Expected one tarball in ${packDir}, found none.`);
  }
  const tarballPath = join(packDir, tarballName);
  if (!existsSync(tarballPath)) {
    throw new Error(`pnpm pack did not produce ${tarballPath}.`);
  }
  return tarballPath;
}

function assertTarballHygiene(tarballPath: string): void {
  const list = spawnSync("tar", ["-tzf", tarballPath], {
    encoding: "utf8",
  });
  if (list.status !== 0) {
    throw new Error(list.stdout + list.stderr);
  }

  const entries = list.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const required of requiredPackedPaths) {
    expect(entries).toContain(required);
  }

  for (const entry of entries) {
    for (const pattern of forbiddenPackedPathPatterns) {
      expect(entry).not.toMatch(pattern);
    }
  }
}

function writeProjectFile(fixtureDir: string, filename: string, contents: string): void {
  writeFileSync(join(fixtureDir, filename), contents);
}
