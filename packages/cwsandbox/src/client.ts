// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { DEFAULT_KEEP_ALIVE_COMMAND } from "./defaults.js";
import { normalizeCommand } from "./internal/commands.js";
import { ignoreMissingSandbox } from "./internal/delete.js";
import {
  validateDeleteOptions,
  validateListSandboxesOptions,
  validateRequestOptions,
  validateSandboxRunOptions,
} from "./internal/validation/index.js";
import type { CommandInput } from "./public/commands.js";
import type {
  DeleteOptions,
  FromIdOptions,
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  SandboxId,
  SandboxInfo,
  SandboxListOptions,
  SandboxRunOptions,
} from "./public/sandbox.js";
import { SandboxList } from "./runtime/sandbox-list.js";
import { Sandbox } from "./sandbox.js";
import type { SandboxTransport } from "./transport.js";

export interface SandboxClientOptions {
  readonly transport: SandboxTransport;
}

export type WithSandboxCallback<TResult> = (sandbox: Sandbox) => Promise<TResult> | TResult;

export class SandboxClient {
  private readonly transport: SandboxTransport;

  public constructor(options: SandboxClientOptions) {
    this.transport = options.transport;
  }

  /**
   * Create a long-lived sandbox and wait until it is ready for SDK operations.
   *
   * Uses the SDK default keep-alive command for the sandbox main process. Pass
   * `waitUntilRunning: false` to resolve after the backend accepts the start
   * request instead of waiting for lifecycle readiness.
   */
  public async create(options: SandboxRunOptions = {}): Promise<Sandbox> {
    return this.run(DEFAULT_KEEP_ALIVE_COMMAND, options);
  }

  /**
   * Start a sandbox with a custom main process and wait until it is running.
   *
   * The command runs as the sandbox's main process and drives sandbox logs.
   * Pass `waitUntilRunning: false` to resolve after the backend accepts the
   * start request.
   */
  public async run(command: CommandInput, options: SandboxRunOptions = {}): Promise<Sandbox> {
    const transport = this.transport;
    const normalizedCommand = normalizeCommand(command);
    validateSandboxRunOptions(options);
    const { waitUntilRunning, ...startOptions } = options;
    const result = await transport.start({ ...startOptions, command: normalizedCommand });

    const sandbox = new Sandbox({
      metadata: result,
      sandboxId: result.sandboxId,
      transport,
    });

    if (waitUntilRunning !== false) {
      await sandbox.wait({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    }

    return sandbox;
  }

  public async get(sandboxId: SandboxId, options: FromIdOptions = {}): Promise<GetSandboxResult> {
    validateRequestOptions(options);
    return this.transport.get({ ...options, sandboxId });
  }

  public async fromId(sandboxId: SandboxId, options: FromIdOptions = {}): Promise<Sandbox> {
    const result = await this.get(sandboxId, options);

    return new Sandbox({
      metadata: result,
      sandboxId,
      transport: this.transport,
    });
  }

  public async list(options: ListSandboxesOptions = {}): Promise<ListSandboxesResult> {
    validateListSandboxesOptions(options);
    return this.transport.list(options);
  }

  /**
   * List matching sandboxes by following `nextPageToken`.
   *
   * Returns a lazy `SandboxList`: iterate sandboxes one-by-one, call
   * `.byPage()` for page batches, or `.collect()` for a full array. Handles
   * are built from list metadata only. `timeoutMs` is a wall-clock budget
   * across pages (default 300s), not a per-page timeout.
   */
  public listSandboxes(options: SandboxListOptions = {}): SandboxList {
    validateListSandboxesOptions(options);
    return new SandboxList(
      (pageOptions) => this.list(pageOptions),
      (info) => this.toSandbox(info),
      options,
    );
  }

  /**
   * List every sandbox matching the filters by following `nextPageToken`.
   *
   * Alias of `listSandboxes(options).collect()`.
   */
  public async listAll(options: SandboxListOptions = {}): Promise<readonly Sandbox[]> {
    return this.listSandboxes(options).collect();
  }

  private toSandbox(info: SandboxInfo): Sandbox {
    return new Sandbox({
      metadata: info,
      sandboxId: info.sandboxId,
      transport: this.transport,
    });
  }

  public async delete(sandboxId: SandboxId, options: DeleteOptions = {}): Promise<void> {
    validateDeleteOptions(options);
    const { missingOk, ...requestOptions } = options;
    await ignoreMissingSandbox(
      this.transport.delete({ ...requestOptions, sandboxId }),
      missingOk === true,
    );
  }

  /**
   * Run short-lived work in a long-lived sandbox and stop it after the callback.
   *
   * The callback receives a `running` sandbox by default. Pass a command as the
   * first argument only when you need a custom sandbox main process.
   */
  public async withSandbox<TResult>(
    callback: WithSandboxCallback<TResult>,
    options?: SandboxRunOptions,
  ): Promise<TResult>;
  public async withSandbox<TResult>(
    command: CommandInput,
    callback: WithSandboxCallback<TResult>,
    options?: SandboxRunOptions,
  ): Promise<TResult>;
  public async withSandbox<TResult>(
    commandOrCallback: CommandInput | WithSandboxCallback<TResult>,
    callbackOrOptions?: SandboxRunOptions | WithSandboxCallback<TResult>,
    options: SandboxRunOptions = {},
  ): Promise<TResult> {
    const sandbox =
      typeof commandOrCallback === "function"
        ? await this.create((callbackOrOptions as SandboxRunOptions | undefined) ?? {})
        : await this.run(commandOrCallback, options);
    const callback =
      typeof commandOrCallback === "function"
        ? commandOrCallback
        : (callbackOrOptions as WithSandboxCallback<TResult>);
    let callbackResult:
      | { readonly ok: true; readonly value: TResult }
      | { readonly error: unknown; readonly ok: false };

    try {
      callbackResult = {
        ok: true,
        value: await callback(sandbox),
      };
    } catch (error) {
      callbackResult = { error, ok: false };
    }

    try {
      await sandbox.stop();
    } catch (error) {
      if (callbackResult.ok) {
        throw error;
      }
    }

    if (!callbackResult.ok) {
      throw callbackResult.error;
    }

    return callbackResult.value;
  }
}
