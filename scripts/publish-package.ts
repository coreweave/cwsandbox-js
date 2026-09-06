// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PublishPackageOptions {
  readonly dryRun?: boolean;
}

const packageDirectory = "packages/cwsandbox";

export function publishPackage({ dryRun = false }: PublishPackageOptions = {}): void {
  const packDirectory = mkdtempSync(join(tmpdir(), "cwsandbox-release-"));
  const pack = spawnSync(
    "pnpm",
    ["--dir", packageDirectory, "pack", "--pack-destination", packDirectory],
    { stdio: "inherit" },
  );
  if (pack.status !== 0) {
    throw new Error(`packing the core package failed with status ${pack.status ?? 1}`);
  }

  const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`expected one core package tarball, found ${tarballs.length}`);
  }

  const tarball = tarballs[0];
  if (tarball === undefined) {
    throw new Error("core package tarball is missing");
  }

  const publishArguments = [
    "publish",
    join(packDirectory, tarball),
    "--tag",
    "beta",
    "--access",
    "public",
  ];
  if (dryRun) {
    publishArguments.push("--dry-run");
  }
  const publish = spawnSync("npm", publishArguments, { stdio: "inherit" });
  if (publish.status !== 0) {
    throw new Error(`publishing the core package failed with status ${publish.status ?? 1}`);
  }
}
