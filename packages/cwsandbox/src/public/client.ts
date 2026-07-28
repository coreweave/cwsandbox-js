// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/** Re-exported to break circular imports: SandboxList lives in runtime. */
import type { SandboxList } from "../runtime/sandbox-list.js";
import type { CommandInput } from "./commands.js";
import type {
  DeleteOptions,
  FromIdOptions,
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  Sandbox,
  SandboxId,
  SandboxListOptions,
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
  withSandbox<TResult>(
    callback: WithSandboxCallback<TResult>,
    options?: SandboxRunOptions,
  ): Promise<TResult>;
  withSandbox<TResult>(
    command: CommandInput,
    callback: WithSandboxCallback<TResult>,
    options?: SandboxRunOptions,
  ): Promise<TResult>;
}
