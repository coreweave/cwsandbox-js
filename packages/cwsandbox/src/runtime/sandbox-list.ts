// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type {
  ListSandboxesOptions,
  ListSandboxesResult,
  SandboxInfo,
  SandboxListOptions,
} from "../public/sandbox.js";
import type { Sandbox } from "../sandbox.js";
import { iterateListPages, listAllFromPages } from "./list-all.js";

type ListPage = (options: ListSandboxesOptions) => Promise<ListSandboxesResult>;
type ToSandbox = (info: SandboxInfo) => Sandbox;

/**
 * Lazy paginated listing of sandboxes.
 *
 * Default async iteration yields individual sandbox handles. Handles are built
 * from list metadata only — no extra RPCs until a method is called on them.
 */
export class SandboxList implements AsyncIterable<Sandbox> {
  private readonly listPage: ListPage;
  private readonly toSandbox: ToSandbox;
  private readonly options: SandboxListOptions;

  public constructor(listPage: ListPage, toSandbox: ToSandbox, options: SandboxListOptions = {}) {
    this.listPage = listPage;
    this.toSandbox = toSandbox;
    this.options = options;
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<Sandbox, void, undefined> {
    for await (const page of this.byPage()) {
      yield* page;
    }
  }

  /** Iterate list pages as they arrive (same timeout / abort / loop guards). */
  public byPage(): AsyncIterable<readonly Sandbox[]> {
    return iterateListPages(this.listPage, this.toSandbox, this.options);
  }

  /** Collect every matching sandbox across pages into one array. */
  public collect(): Promise<readonly Sandbox[]> {
    return listAllFromPages(this.listPage, this.toSandbox, this.options);
  }
}
