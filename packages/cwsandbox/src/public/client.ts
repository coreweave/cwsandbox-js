// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/** Re-exported to break circular imports: SandboxList lives in runtime. */
import type { SandboxList } from "../runtime/sandbox-list.js";
import type { CommandInput } from "./commands.js";
import type { RequestOptions } from "./common.js";
import type {
  DeleteOptions,
  DeleteSnapshotOptions,
  FileSystemSnapshotResult,
  FromIdOptions,
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  ListSnapshotsOptions,
  Sandbox,
  SandboxId,
  SandboxListOptions,
  SandboxRunFromTemplateOptions,
  SandboxRunOptions,
} from "./sandbox.js";

export type WithSandboxCallback<TResult> = (sandbox: Sandbox) => Promise<TResult> | TResult;

/** Public interface returned by all CWSandbox client factories. */
export interface SandboxClient {
  create(options?: SandboxRunOptions): Promise<Sandbox>;
  run(command: CommandInput, options?: SandboxRunOptions): Promise<Sandbox>;
  get(sandboxId: SandboxId, options?: FromIdOptions): Promise<GetSandboxResult>;
  fromId(sandboxId: SandboxId, options?: FromIdOptions): Promise<Sandbox>;
  list(options?: ListSandboxesOptions): Promise<ListSandboxesResult>;
  listSandboxes(options?: SandboxListOptions): SandboxList;
  listAll(options?: SandboxListOptions): Promise<readonly Sandbox[]>;
  delete(sandboxId: SandboxId, options?: DeleteOptions): Promise<void>;
  getSnapshot(snapshotId: string, options?: RequestOptions): Promise<FileSystemSnapshotResult>;
  listSnapshots(options?: ListSnapshotsOptions): Promise<readonly FileSystemSnapshotResult[]>;
  deleteSnapshot(snapshotId: string, options?: DeleteSnapshotOptions): Promise<void>;
  withSandbox<TResult>(
    callback: WithSandboxCallback<TResult>,
    options?: SandboxRunOptions,
  ): Promise<TResult>;
  withSandbox<TResult>(
    command: CommandInput,
    callback: WithSandboxCallback<TResult>,
    options?: SandboxRunOptions,
  ): Promise<TResult>;
  /**
   * Starts from an organization template. Omitted options preserve template
   * values unless `containerImage` is supplied.
   *
   * Non-empty top-level collections replace template values. Empty top-level
   * collections/maps (`tags: []`, `services: []`, `annotations: {}`,
   * `runnerIds: []`) mean "no override," not "clear." `maxLifetimeSeconds: 0`
   * similarly preserves the template. There is no general clear-to-empty
   * operation on this surface.
   *
   * Once `containerImage` is supplied, the entire container list is replaced
   * with one `main` container. Omitted or empty container fields result in
   * empty/default values rather than inheritance.
   *
   * If creation returns an accepted sandbox but the readiness wait rejects, the
   * SDK best-effort stops it and rethrows the original readiness error.
   * `waitUntilRunning: false` returns immediately after accept with no
   * automatic cleanup.
   *
   * @param templateId Non-empty organization-scoped UUID. Format validation is
   *   performed by the backend.
   */
  runFromTemplate(templateId: string, options?: SandboxRunFromTemplateOptions): Promise<Sandbox>;
  /**
   * Starts from an organization template and always stops the sandbox after the
   * callback returns or throws. A callback error is rethrown; a cleanup failure
   * after a successful callback is thrown; a cleanup failure after a callback
   * or readiness error does not replace that error.
   *
   * Overlay semantics match `runFromTemplate`. The helper accepts the sandbox
   * first, then waits (unless `waitUntilRunning: false`) before the callback so
   * a readiness failure still `stop`s and the callback is not run.
   *
   * @param templateId Non-empty organization-scoped UUID. Format validation is
   *   performed by the backend.
   */
  withSandboxFromTemplate<TResult>(
    templateId: string,
    callback: WithSandboxCallback<TResult>,
    options?: SandboxRunFromTemplateOptions,
  ): Promise<TResult>;
}
