// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GENERATED_DIR = new URL("../src/transports/node-grpc/generated/", import.meta.url);

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : Promise.resolve([path]);
    }),
  );

  return files.flat();
}

function addJsExtensions(source: string): string {
  return source.replaceAll(
    /(from\s+["'])(\.[^"']*?)(["'])/g,
    (_match, prefix, specifier, suffix) => {
      if (specifier.endsWith(".js")) {
        return `${prefix}${specifier}${suffix}`;
      }

      return `${prefix}${specifier}.js${suffix}`;
    },
  );
}

async function main(): Promise<void> {
  const files = (await walk(GENERATED_DIR.pathname)).filter((file) => file.endsWith(".ts"));

  await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, "utf8");
      const withExtensions = addJsExtensions(source);
      const next = withExtensions.startsWith("// @ts-nocheck")
        ? withExtensions
        : `// @ts-nocheck\n${withExtensions}`;

      await writeFile(file, next);
    }),
  );
}

await main();
