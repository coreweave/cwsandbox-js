// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { publishRelease } from "./publish-release.js";

describe("publish release", () => {
  it("checks approval before publishing and writes notes only after publication", async () => {
    const operations: string[] = [];
    const identity = { version: "0.5.0-beta.0", tag: "v0.5.0-beta.0" };

    const result = await publishRelease(
      {},
      {
        checkRelease: async () => {
          operations.push("check");
          return identity;
        },
        publishPackage: () => {
          operations.push("publish");
        },
        buildReleaseNotes: () => {
          operations.push("notes");
          return "Release notes";
        },
        writeReleaseNotes: () => {
          operations.push("write");
        },
      },
    );

    expect(result).toEqual(identity);
    expect(operations).toEqual(["check", "publish", "notes", "write"]);
  });

  it("forwards dry-run mode to package publishing", async () => {
    let receivedDryRun: boolean | undefined;

    await publishRelease(
      { dryRun: true },
      {
        checkRelease: async () => ({
          version: "0.5.0-beta.0",
          tag: "v0.5.0-beta.0",
        }),
        publishPackage: (options) => {
          receivedDryRun = options?.dryRun;
        },
        buildReleaseNotes: () => "Release notes",
        writeReleaseNotes: () => {},
      },
    );

    expect(receivedDryRun).toBe(true);
  });

  it("does not publish or create notes when approval checks fail", async () => {
    const operations: string[] = [];

    await expect(
      publishRelease(
        {},
        {
          checkRelease: async () => {
            throw new Error("unapproved release");
          },
          publishPackage: () => {
            operations.push("publish");
          },
          buildReleaseNotes: () => {
            operations.push("notes");
            return "Release notes";
          },
          writeReleaseNotes: () => {
            operations.push("write");
          },
        },
      ),
    ).rejects.toThrow("unapproved release");

    expect(operations).toEqual([]);
  });
});
