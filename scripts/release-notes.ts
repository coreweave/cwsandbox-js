// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { readFileSync } from "node:fs";

interface PackageManifest {
  readonly version: string;
}

export function buildReleaseNotes(): string {
  const manifest = JSON.parse(
    readFileSync("packages/cwsandbox/package.json", "utf8"),
  ) as PackageManifest;
  const changelog = readFileSync("packages/cwsandbox/CHANGELOG.md", "utf8");
  const heading = `## ${manifest.version}`;
  const start = changelog.indexOf(heading);
  const end = changelog.indexOf("\n## ", start + heading.length);
  if (start === -1) {
    throw new Error(`changelog has no entry for ${manifest.version}`);
  }

  const notes = changelog.slice(start + heading.length, end === -1 ? undefined : end).trim();
  if (notes.length === 0) {
    throw new Error(`changelog entry for ${manifest.version} is empty`);
  }
  return notes;
}
