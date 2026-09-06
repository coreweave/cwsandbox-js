// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  type AssociatedPullRequest,
  findApprovedReleasePullRequest,
} from "./release-provenance.js";

function pullRequest(overrides: Partial<AssociatedPullRequest> = {}): AssociatedPullRequest {
  return {
    number: 72,
    state: "closed",
    merged_at: "2026-09-03T12:00:00Z",
    title: "chore: release packages",
    base: { ref: "main" },
    head: { ref: "changeset-release/main" },
    ...overrides,
  };
}

describe("release provenance", () => {
  it("accepts a merged Changesets release pull request", () => {
    expect(findApprovedReleasePullRequest([pullRequest()])?.number).toBe(72);
  });

  it.each([
    pullRequest({ state: "open", merged_at: null }),
    pullRequest({ title: "feat: ordinary change" }),
    pullRequest({ base: { ref: "release" } }),
    pullRequest({ head: { ref: "feature/manual-version-bump" } }),
  ])("rejects an unapproved pull request %#", (candidate) => {
    expect(findApprovedReleasePullRequest([candidate])).toBeUndefined();
  });
});
