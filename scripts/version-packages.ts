// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const manifestPath = "packages/cwsandbox/package.json";
const changelogPath = "packages/cwsandbox/CHANGELOG.md";

interface PackageManifest {
  readonly version: string;
}

function readVersion(): string {
  return (JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest).version;
}

export function normalizeChangelog(before: string, generated: string): string {
  const firstNewline = before.indexOf("\n");
  if (firstNewline === -1) {
    throw new Error(`${changelogPath} must contain a document header`);
  }

  // Changesets inserts a release below the first line. This repository puts an
  // SPDX comment before its Markdown title, so recover that generated block and
  // move it below the permanent Unreleased heading.
  const prefix = `${before.slice(0, firstNewline)}\n\n`;
  const originalTail = before.slice(firstNewline + 1);
  if (!generated.startsWith(prefix) || !generated.endsWith(originalTail)) {
    throw new Error(`Changesets produced an unexpected ${changelogPath} layout`);
  }

  const releaseBlock = generated
    .slice(prefix.length, generated.length - originalTail.length)
    .trim();
  const unreleasedHeading = "## Unreleased";
  const headingStart = before.indexOf(unreleasedHeading);
  const headingEnd = before.indexOf("\n", headingStart) + 1;
  const nextRelease = before.indexOf("\n## ", headingEnd);
  if (headingStart === -1 || headingEnd === 0 || nextRelease === -1) {
    throw new Error(`${changelogPath} must contain Unreleased and release sections`);
  }

  const preamble = before.slice(0, headingEnd).trimEnd();
  const pendingNotes = before.slice(headingEnd, nextRelease).trim();
  const history = before.slice(nextRelease + 1).trim();
  return [preamble, releaseBlock, pendingNotes, history]
    .filter((section) => section.length > 0)
    .join("\n\n")
    .concat("\n");
}

function versionPackages(): void {
  const versionBefore = readVersion();
  const changelogBefore = readFileSync(changelogPath, "utf8");
  const result = spawnSync("pnpm", ["exec", "changeset", "version"], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  if (readVersion() !== versionBefore) {
    const generatedChangelog = readFileSync(changelogPath, "utf8");
    writeFileSync(changelogPath, normalizeChangelog(changelogBefore, generatedChangelog));
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  versionPackages();
}
