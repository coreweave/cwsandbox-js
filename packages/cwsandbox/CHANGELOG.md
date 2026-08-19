<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: BSD-3-Clause
SPDX-PackageName: cwsandbox
-->

# Changelog

## Unreleased

- Cut the public SDK from Sandbox v1beta2 to v1 (`CreateSandbox`, one
  `SandboxService`, pinned BSR commit `95e41f6a01534851b3e000549a1b2144`)
- Replace `ports` / `egressMode` / `ingressMode` / `exposedPorts` with
  `services` and `network.denyEgress` / `network.denyIngress`
- Reject `ports`, `profileIds`, `profileNames`, and `includeStopped` with
  `{field} is not supported in v1`
- List terminals with `showTerminated`; inspect now exposes `serviceUrls`
  instead of `profileId` / `serviceAddress` / applied network modes
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
