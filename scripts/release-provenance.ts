// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

const releasePrBase = "main";
const releasePrHead = "changeset-release/main";
const releasePrTitle = "chore: release packages";

export interface AssociatedPullRequest {
  readonly number: number;
  readonly state: string;
  readonly merged_at: string | null;
  readonly title: string;
  readonly base: {
    readonly ref: string;
  };
  readonly head: {
    readonly ref: string;
  };
}

export function findApprovedReleasePullRequest(
  pullRequests: readonly AssociatedPullRequest[],
): AssociatedPullRequest | undefined {
  return pullRequests.find(
    (pullRequest) =>
      pullRequest.state === "closed" &&
      pullRequest.merged_at !== null &&
      pullRequest.base.ref === releasePrBase &&
      pullRequest.head.ref === releasePrHead &&
      pullRequest.title === releasePrTitle,
  );
}

export async function verifyReleasePullRequest(): Promise<AssociatedPullRequest> {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const token = process.env.GITHUB_TOKEN;
  if (repository === undefined || sha === undefined || token === undefined) {
    throw new Error("release provenance requires GITHUB_REPOSITORY, GITHUB_SHA, and GITHUB_TOKEN");
  }

  const response = await fetch(
    `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(sha)}/pulls`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`could not verify release PR for ${sha}: GitHub returned ${response.status}`);
  }

  const pullRequests = (await response.json()) as AssociatedPullRequest[];
  const releasePullRequest = findApprovedReleasePullRequest(pullRequests);
  if (releasePullRequest === undefined) {
    throw new Error(
      `${sha} is not associated with a merged ${releasePrHead} PR titled ${JSON.stringify(releasePrTitle)}`,
    );
  }

  return releasePullRequest;
}
