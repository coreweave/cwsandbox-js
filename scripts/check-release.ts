// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";

import { verifyReleasePullRequest } from "./release-provenance.js";

const manifestPath = "packages/cwsandbox/package.json";
const changelogPath = "packages/cwsandbox/CHANGELOG.md";
const expectedName = "@coreweave/cwsandbox";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly publishConfig?: {
    readonly access?: string;
  };
}

interface ChangesetsConfig {
  readonly ignore: readonly string[];
}

export interface ReleaseIdentity {
  readonly version: string;
  readonly tag: string;
}

export async function checkRelease(): Promise<ReleaseIdentity> {
  const releasePullRequest = await verifyReleasePullRequest();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  if (manifest.name !== expectedName) {
    throw new Error(`release allowlist expected ${expectedName}, got ${manifest.name}`);
  }
  if (manifest.private === true || manifest.publishConfig?.access !== "public") {
    throw new Error(`${expectedName} must be configured as a public package`);
  }
  if (!/^0\.\d+\.0-beta\.\d+$/.test(manifest.version)) {
    throw new Error(`release version must be a 0.x beta, got ${manifest.version}`);
  }

  const releaseConfig = JSON.parse(
    readFileSync(".changeset/config.json", "utf8"),
  ) as ChangesetsConfig;
  const packageNames = readdirSync("packages", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageManifest = JSON.parse(
        readFileSync(`packages/${entry.name}/package.json`, "utf8"),
      ) as PackageManifest;
      return packageManifest.name;
    });
  const accidentallyPublishable = packageNames.filter(
    (name) => name !== expectedName && !releaseConfig.ignore.includes(name),
  );
  if (accidentallyPublishable.length > 0) {
    throw new Error(
      `release allowlist excludes packages missing from changesets ignore: ${accidentallyPublishable.join(", ")}`,
    );
  }

  const changelog = readFileSync(changelogPath, "utf8");
  if (!changelog.includes(`## ${manifest.version}\n`)) {
    throw new Error(`${changelogPath} has no entry for ${manifest.version}`);
  }

  const packageVersion = `${manifest.name}@${manifest.version}`;
  const npmView = spawnSync("npm", ["view", packageVersion, "version", "--json"], {
    encoding: "utf8",
  });
  if (npmView.status === 0) {
    throw new Error(`${packageVersion} already exists in npm`);
  }
  if (!npmView.stderr.includes("E404")) {
    throw new Error(`could not verify ${packageVersion} in npm:\n${npmView.stderr}`);
  }

  const identity = { version: manifest.version, tag: `v${manifest.version}` };
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput !== undefined) {
    appendFileSync(githubOutput, `version=${identity.version}\ntag=${identity.tag}\n`);
  }

  console.log(
    `${packageVersion} from approved release PR #${releasePullRequest.number} is ready for its first publish attempt`,
  );
  return identity;
}
