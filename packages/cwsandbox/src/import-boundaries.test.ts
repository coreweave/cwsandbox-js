// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcRoot = dirname(fileURLToPath(import.meta.url));
const nodeGrpcRoot = join(srcRoot, "transports", "node-grpc");

interface ImportReference {
  readonly file: string;
  readonly resolvedPath: string | undefined;
  readonly specifier: string;
}

describe("source import boundaries", () => {
  const imports = sourceImports();

  it("keeps generated protobuf imports inside the node-grpc transport", () => {
    const violations = imports.filter(
      (entry) =>
        entry.resolvedPath?.includes("/generated/") === true && !isWithin(entry.file, nodeGrpcRoot),
    );

    expect(formatViolations(violations)).toEqual([]);
  });

  it("keeps public type modules independent from internal helpers", () => {
    const publicRoot = join(srcRoot, "public");
    const violations = imports.filter(
      (entry) =>
        isWithin(entry.file, publicRoot) && entry.resolvedPath?.includes("/internal/") === true,
    );

    expect(formatViolations(violations)).toEqual([]);
  });

  it("prevents implementation files from importing through public subpath shims", () => {
    const publicShimFiles = new Set([
      join(srcRoot, "node", "index.ts"),
      join(srcRoot, "wandb", "index.ts"),
    ]);
    const violations = imports.filter((entry) => {
      if (isTestFile(entry.file)) {
        return false;
      }
      if (publicShimFiles.has(entry.file)) {
        return false;
      }

      return entry.resolvedPath !== undefined && publicShimFiles.has(entry.resolvedPath);
    });

    expect(formatViolations(violations)).toEqual([]);
  });

  it("keeps gRPC and protobuf runtime dependencies inside the node-grpc transport", () => {
    const violations = imports.filter(
      (entry) =>
        (entry.specifier.startsWith("@grpc/") || entry.specifier.startsWith("@protobuf-ts/")) &&
        !isWithin(entry.file, nodeGrpcRoot),
    );

    expect(formatViolations(violations)).toEqual([]);
  });

  it("keeps FileTransfer independent from commands and concrete adapters", () => {
    const fileTransfer = join(srcRoot, "runtime", "file-transfer.ts");
    const forbidden = imports.filter((entry) => {
      if (entry.file !== fileTransfer || entry.resolvedPath === undefined) {
        return false;
      }
      return (
        entry.resolvedPath === join(srcRoot, "runtime", "commands.ts") ||
        isWithin(entry.resolvedPath, nodeGrpcRoot)
      );
    });

    expect(formatViolations(forbidden)).toEqual([]);
  });
});

function sourceImports(): readonly ImportReference[] {
  return tsFiles(srcRoot).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [
      ...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g),
    ].map((match) => {
      const specifier = match[1] ?? "";
      return {
        file,
        resolvedPath: resolveLocalImport(file, specifier),
        specifier,
      };
    });
  });
}

function tsFiles(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    const stats = statSync(path);

    if (stats.isDirectory()) {
      return tsFiles(path);
    }

    return path.endsWith(".ts") ? [path] : [];
  });
}

function resolveLocalImport(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const resolved = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
  return resolved.startsWith(srcRoot) ? resolved : undefined;
}

function isWithin(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/"));
}

function isTestFile(path: string): boolean {
  return path.endsWith(".test.ts") || path.endsWith(".test-d.ts");
}

function formatViolations(violations: readonly ImportReference[]): readonly string[] {
  return violations.map((entry) => `${relative(srcRoot, entry.file)} imports ${entry.specifier}`);
}
