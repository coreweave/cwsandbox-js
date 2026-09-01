<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: BSD-3-Clause
SPDX-PackageName: cwsandbox
-->

# Changelog

## Unreleased

- Normalize inspect/`exposedPorts` protocols to lowercase `tcp` / `udp` /
  `sctp` (`ServiceProtocol`) instead of uppercase proto names. Beta API
  normalization: create and inspect now share the same protocol strings.

## 0.4.0-beta.0

- Add `client.runFromTemplate(templateId, options?)` and
  `client.withSandboxFromTemplate(templateId, callback, options?)` to start
  sandboxes from an organization template. Omitted overlays inherit. Empty
  `tags` / `services` / `annotations` / `runnerIds` inherit. Any defined
  `network`, including `{}`, replaces the template network. `containerImage`
  replaces the whole container list (omitted container fields, including
  `imagePullCredentials`, are not inherited). Template overlays do not accept
  `objectStorageAccess`. A rejected readiness wait after accept best-effort
  `stop`s the sandbox and rethrows the original error. Live smoke is reduced:
  set `CWSANDBOX_TEMPLATE_ID` to a pre-created org template; the suite does
  not mint or delete that template.
- Add `network.egress` create-time DNS-name HTTPS grants (`{ dnsName }`) and
  echo granted names as `dnsEgressNames` from status. Exact names or a single
  leftmost wildcard; `"*"` is not a sandbox grant and cannot combine with
  `denyEgress`.

## 0.3.0-beta.0

- Add `fileSystemSnapshot` create option, `sandbox.snapshot()`,
  `client.getSnapshot`, `client.listSnapshots`, and
  `client.deleteSnapshot(snapshotId, { missingOk })` for scratch-volume archives
  (not container overlay). Default snapshot wait is 600s plus 5s observation
  slack. `snapshot()` returns the READY Get record (Python `snapshot()` returns
  only the ID; use `get_snapshot` there). `listSnapshots` collects all pages
  and filters `sourceSandboxId` / `state` client-side.
- Add `volumes` / `ScratchVolumeOptions` on create for named scratch mounts
  (mutually exclusive with `fileSystemSnapshot`). Convenience create still
  names the volume `workspace`. `snapshot()` omits `scratchVolumeName` for a
  single scratch and rejects client-side when this process created more than
  one.
- Add `objectStorageAccess` on create for temporary object-storage credentials.
- Map trusted `CWSANDBOX_FSS_SIZE_EXCEEDED`, `CWSANDBOX_FSS_QUOTA_EXCEEDED`,
  and `CWSANDBOX_FSS_BUCKET_MISMATCH` to dedicated
  `CWSandboxTransportError` subclasses (`CWSandboxSnapshotSizeExceededError`,
  `CWSandboxSnapshotQuotaExceededError`,
  `CWSandboxSnapshotBucketMismatchError`). `CWSANDBOX_FSS_NOT_READY` stays a
  generic transport error; throttle / inflight / bucket-provisioning stay
  unavailable.

Sandbox v1 public beta. Breaking vs `0.1.0-beta.0` (v1beta2 create options
and inspect fields).

- Cut the public SDK from Sandbox v1beta2 to v1 (`CreateSandbox`, one
  `SandboxService`, pinned BSR commit `95e41f6a01534851b3e000549a1b2144`)
- Replace create-time `ports` / `egressMode` / `ingressMode` with `services`
  and `network.denyEgress` / `network.denyIngress`. Removed names are omitted
  from v1 types and are not mapped. Inspect still reports `exposedPorts` as
  output; that is not the removed create-time `ports` field. `denyIngress`
  only affects CUSTOM-visibility ports.
- List terminal-state sandboxes with `showTerminated`; inspect now exposes
  `serviceUrls` instead of `profileId` / `serviceAddress` / applied network
  modes. A `serviceUrls` hostname is assigned, not listening, and not
  edge-ready.
- Remove incomplete public `snapshotOnStop` from `stop()` until file-system
  snapshots (FSS) are supported end-to-end
- Parse AIP-193 `ErrorInfo` / `RetryInfo` from gRPC status details and expose
  `reason`, `domain`, `metadata`, and `retryDelayMs` on transport errors
- Domain-gated remaps for `CWSANDBOX_SANDBOX_NOT_FOUND` and unavailable reasons
- Add `missingOk` (default `false`) to `stop` and `delete`; deleting a missing
  sandbox no longer always succeeds — pass `{ missingOk: true }` for cleanup

## 0.1.0-beta.0

Initial public beta packaging for `@coreweave/cwsandbox`.

- Multi-package monorepo layout under `packages/cwsandbox`
- Publish metadata (`repository`, `homepage`, `bugs`, `publishConfig`)
- ESM-only Node.js `>=22` SDK with `/node` and `/wandb` entrypoints
