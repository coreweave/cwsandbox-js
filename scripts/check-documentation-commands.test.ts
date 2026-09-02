// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly name?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

interface PnpmCommand {
  readonly file: string;
  readonly line: number;
  readonly packageDirectory?: string;
  readonly packageFilter?: string;
  readonly script: string;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const builtinCommands = new Set([
  "add",
  "approve-builds",
  "exec",
  "install",
  "pack",
  "publish",
  "store",
]);

describe("documented pnpm commands", () => {
  const packages = packageManifests();
  const commands = markdownFiles(repoRoot).flatMap(pnpmCommands);

  it("finds commands to validate", () => {
    expect(commands.length).toBeGreaterThan(0);
  });

  it.each(commands)("$file:$line references an existing script", (command) => {
    const manifest = resolveManifest(command, packages);
    expect(
      manifest.scripts,
      `${command.file}:${command.line} references a package without scripts`,
    ).toBeDefined();
    expect(
      manifest.scripts,
      `${command.file}:${command.line} references missing pnpm script ${command.script}`,
    ).toHaveProperty(command.script);
  });
});

function markdownFiles(directory: string): readonly string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }

  return files;
}

function pnpmCommands(path: string): readonly PnpmCommand[] {
  const markdown = readFileSync(path, "utf8");
  const commands: PnpmCommand[] = [];
  let shellFence = false;

  for (const [lineIndex, line] of markdown.split("\n").entries()) {
    const fence = line.match(/^\s*```([^\s]*)/);
    if (fence !== null) {
      const language = fence[1];
      shellFence = shellFence
        ? false
        : language === "bash" || language === "sh" || language === "shell";
      continue;
    }

    const fragments = shellFence
      ? [line]
      : [...line.matchAll(/`([^`]*\bpnpm\b[^`]*)`/g)].map((match) => match[1] ?? "");
    for (const fragment of fragments) {
      const invocation = fragment.match(/\bpnpm\s+(.+)$/);
      if (invocation === null) {
        continue;
      }

      const tokens = invocation[1]
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/[),.;]+$/, ""));
      const parsed = parseCommand(tokens);
      if (parsed === undefined || builtinCommands.has(parsed.script)) {
        continue;
      }

      commands.push({
        file: relative(repoRoot, path),
        line: lineIndex + 1,
        ...parsed,
      });
    }
  }

  return commands;
}

function parseCommand(tokens: readonly string[]): Omit<PnpmCommand, "file" | "line"> | undefined {
  let index = 0;
  let packageDirectory: string | undefined;
  let packageFilter: string | undefined;

  while (tokens[index]?.startsWith("-") === true) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if ((option === "--dir" || option === "-C") && value !== undefined) {
      packageDirectory = value;
      index += 2;
    } else if ((option === "--filter" || option === "-F") && value !== undefined) {
      packageFilter = value;
      index += 2;
    } else {
      return undefined;
    }
  }

  if (tokens[index] === "run") {
    index += 1;
  }

  const script = tokens[index];
  if (script === undefined || script === "") {
    return undefined;
  }

  return {
    ...(packageDirectory === undefined ? {} : { packageDirectory }),
    ...(packageFilter === undefined ? {} : { packageFilter }),
    script,
  };
}

function packageManifests(): ReadonlyMap<string, PackageManifest> {
  const manifests = new Map<string, PackageManifest>();

  for (const path of packageJsonFiles(repoRoot)) {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
    manifests.set(dirname(path), manifest);
    if (manifest.name !== undefined) {
      manifests.set(manifest.name, manifest);
    }
  }

  return manifests;
}

function packageJsonFiles(directory: string): readonly string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...packageJsonFiles(path));
    } else if (entry.isFile() && entry.name === "package.json") {
      files.push(path);
    }
  }

  return files;
}

function resolveManifest(
  command: PnpmCommand,
  packages: ReadonlyMap<string, PackageManifest>,
): PackageManifest {
  const key =
    command.packageFilter ??
    (command.packageDirectory === undefined
      ? repoRoot
      : resolve(repoRoot, command.packageDirectory));
  const manifest = packages.get(key);

  if (manifest === undefined) {
    throw new Error(
      `${command.file}:${command.line} references unknown package ${command.packageFilter ?? command.packageDirectory ?? "."}`,
    );
  }

  return manifest;
}
