<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: Apache-2.0
SPDX-PackageName: cwsandbox
-->

# Release Policy

This document defines how CWSandbox JS releases are selected, approved, published,
and recovered. The workflow in `.github/workflows/release.yml` implements this policy.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are used as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Release scope

The initial automated release scope contains only the published core package:

- `@coreweave/cwsandbox`

The following packages MUST remain excluded from automated npm publishing until a
separate readiness review approves each package:

- `@coreweave/cwsandbox-tanstack`
- `@coreweave/cwsandbox-computesdk`

An adapter readiness review MUST verify package metadata, packed contents, external
consumer installation, documentation, and ownership in npm. After their first
release, published packages SHOULD use the same version and release together. The
release implementation MUST use an explicit package allowlist so adding a workspace
package cannot publish it accidentally.

## Versioning during beta

Releases follow Semantic Versioning and remain on the `0.x` beta line until the public
API is declared stable.

- A breaking public API change or compatible user-facing feature increments the minor
  version and resets the prerelease number, for example `0.4.0-beta.0` to
  `0.5.0-beta.0`. Breaking changes MUST be identified explicitly in the changelog.
- A compatible fix to the current beta line increments the prerelease number, for
  example `0.5.0-beta.0` to `0.5.0-beta.1`.
- Documentation, tests, examples, and internal refactors do not by themselves require
  a release. Maintainers MAY include user-facing package documentation in the next
  release rather than publishing it immediately.
- A release MUST NOT reuse or overwrite a version already present in npm.

The version proposed by release automation is advisory until the release pull request
is approved. Maintainers MAY adjust the proposed version before merging that pull
request.

## npm distribution tags

Beta releases MUST publish with the npm `beta` distribution tag. Automation MUST NOT
move the `latest` tag while the SDK remains beta. The first stable release will define
the process for moving `latest`; until then, an existing `latest` tag that points to a
beta version is legacy registry state rather than the intended release channel.

## Release flow and approval

The automated release flow SHOULD be:

1. Changes eligible for release merge to `main` with a Changesets file created by
   `pnpm changeset`.
2. Automation opens or updates a release pull request containing the exact version and
   changelog changes.
3. A maintainer reviews and merges the release pull request.
4. The publishing job verifies that the commit came from the merged Changesets release
   pull request, then packs and publishes the allowlisted packages from that commit.
5. Automation creates the Git tag and GitHub Release for the published commit.

Merging an ordinary feature or fix pull request MUST NOT publish directly. During beta,
merging the release pull request is the human approval gate. The publish job MUST use
the `release` GitHub Environment, restricted to the `main` branch, so npm can enforce
the same branch boundary through its trusted-publisher identity. Required environment
reviewers are not enabled, so the environment does not add a second human approval.
The workflow supports manual retry of a failed publishing job, but a manual run MUST
publish only a version already approved in a merged release pull request.

## Required release checks

Before publishing, automation MUST:

- use the lockfile and pinned package-manager version from the repository;
- run `pnpm check` from a clean checkout of the release commit;
- pack each allowlisted package and validate its contents;
- verify that internal workspace dependencies resolve to publishable versions;
- verify through GitHub that the commit is associated with the merged
  `changeset-release/main` release pull request;
- verify that the proposed version does not already exist in npm; and
- publish from a GitHub-hosted runner using npm trusted publishing with OpenID Connect,
  without a long-lived npm write token.

Live service tests are not part of credential-free `pnpm check`. The publishing
workflow MUST NOT silently add billable live tests; any release smoke test that uses a
service credential requires a separately documented environment and cleanup policy.

After automated publishing is enabled, maintainers SHOULD NOT publish from local
workstations. An emergency manual publish requires agreement from an npm package owner
and must still use an approved version and the release commit.

## One-time setup

Before the first automated publish, a repository administrator MUST:

1. Enable **Allow GitHub Actions to create and approve pull requests** under Actions
   settings.
2. Create a GitHub Environment named `release`. Under **Deployment branches and
   tags**, choose **Selected branches and tags** and allow only the `main` branch. No
   required reviewer is needed.

An npm package owner MUST configure `@coreweave/cwsandbox` trusted publishing with:

- repository: `coreweave/cwsandbox-js`;
- workflow filename: `release.yml` (the filename only, not its full path);
- environment name: `release`; and
- allowed action: `npm publish`.

No npm token is stored in GitHub. If branch protection later requires checks that do
not run for pull requests created with the repository token, replace the version job's
token with a narrowly scoped GitHub App token.

## Changelog, tags, and GitHub Releases

Each published release MUST update `packages/cwsandbox/CHANGELOG.md`. When adapters are
published, each package MUST have release notes for its user-visible changes.

The repository uses one lockstep release tag in the form `v<version>`, for example
`v0.5.0-beta.0`. A tag MUST point to the exact commit whose package artifacts were
published. Tags and GitHub Releases MUST be created only after npm publication
succeeds, and existing release tags MUST NOT be moved or replaced.

The GitHub Release title SHOULD match the tag. Its notes MAY summarize multiple
packages, but MUST link or reproduce the relevant package changelog entries.

## Failed releases and recovery

Package versions in npm are immutable. Recovery MUST produce a new version rather than
rebuilding or replacing a published version.

- If verification fails before publication, fix the cause and rerun only after the
  release commit remains the approved source.
- If publication fails before any package is published, the protected job MAY be
  retried for the same release commit and version.
- If only part of a future multi-package release publishes, do not move tags or create
  the GitHub Release. Publish corrected, new versions for the complete release set.
- If a published beta is broken, an npm package owner should deprecate it when useful,
  move the `beta` tag back to the last known-good version, and publish a corrected
  version.
- Unpublishing SHOULD be reserved for security, legal, or sensitive-data incidents and
  requires an npm package owner. Ordinary defects use deprecation and a follow-up
  release.

Recovery actions and their reason SHOULD be recorded in the related GitHub Release or
issue so package state and source history remain auditable.

## Changing this policy

Policy changes use a normal pull request and maintainer review. A publishing workflow
change that alters release scope, approval, versioning, tags, or recovery behavior MUST
update this document in the same pull request.
