// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkRelease, type ReleaseIdentity } from "./check-release.js";
import { publishPackage, type PublishPackageOptions } from "./publish-package.js";
import { buildReleaseNotes } from "./release-notes.js";

export interface PublishReleaseDependencies {
  readonly checkRelease: () => Promise<ReleaseIdentity>;
  readonly publishPackage: (options?: PublishPackageOptions) => void;
  readonly buildReleaseNotes: () => string;
  readonly writeReleaseNotes: (notes: string) => void;
}

const defaultDependencies: PublishReleaseDependencies = {
  checkRelease,
  publishPackage,
  buildReleaseNotes,
  writeReleaseNotes: (notes) => writeFileSync("release-notes.md", `${notes}\n`),
};

export async function publishRelease(
  { dryRun = false }: PublishPackageOptions = {},
  dependencies: PublishReleaseDependencies = defaultDependencies,
): Promise<ReleaseIdentity> {
  const identity = await dependencies.checkRelease();
  dependencies.publishPackage({ dryRun });
  dependencies.writeReleaseNotes(dependencies.buildReleaseNotes());
  return identity;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await publishRelease({ dryRun: process.argv.includes("--dry-run") });
}
