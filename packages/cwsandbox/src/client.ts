// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { DEFAULT_KEEP_ALIVE_COMMAND } from "./defaults.js";
import { normalizeCommand } from "./internal/commands.js";
import { ignoreMissingSandbox } from "./internal/delete.js";
import { scratchVolumeNamesFromRunOptions } from "./internal/validation/file-system-snapshot.js";
import {
  validateDeleteOptions,
  validateDeleteSnapshotOptions,
  validateListSandboxesOptions,
  validateRequestOptions,
  validateSandboxRunFromTemplateOptions,
  validateSandboxRunOptions,
} from "./internal/validation/index.js";
import type { SandboxClient as SandboxClientInterface } from "./public/client.js";
import type { CommandInput } from "./public/commands.js";
import type { RequestOptions } from "./public/common.js";
import type {
  DeleteOptions,
  DeleteSnapshotOptions,
  FileSystemSnapshotResult,
  FromIdOptions,
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  ListSnapshotsOptions,
  Sandbox as PublicSandbox,
  SandboxId,
  SandboxInfo,
  SandboxListOptions,
  SandboxRunFromTemplateOptions,
  SandboxRunOptions,
} from "./public/sandbox.js";
import { SandboxList } from "./runtime/sandbox-list.js";
import { getSnapshotRecord, listSnapshotRecords } from "./runtime/snapshot-inspect.js";
import { Sandbox as SandboxImpl } from "./sandbox.js";
import type { SandboxTransport } from "./transport.js";
import type { FileAdapter } from "./transport/file-adapter.js";

/** Wall-clock budget for best-effort stop after a failed readiness wait. */
const READINESS_CLEANUP_TIMEOUT_MS = 30_000;

export interface SandboxClientOptions {
  readonly fileAdapter: FileAdapter;
  readonly transport: SandboxTransport;
}

export type WithSandboxCallback<TResult> = (sandbox: PublicSandbox) => Promise<TResult> | TResult;

export class SandboxClient implements SandboxClientInterface {
  private readonly transport: SandboxTransport;
  private readonly fileAdapter: FileAdapter;

  public constructor(options: SandboxClientOptions) {
    this.transport = options.transport;
    this.fileAdapter = options.fileAdapter;
  }

  public async create(options: SandboxRunOptions = {}): Promise<PublicSandbox> {
    return this.run(DEFAULT_KEEP_ALIVE_COMMAND, options);
  }

  public async run(command: CommandInput, options: SandboxRunOptions = {}): Promise<PublicSandbox> {
    const transport = this.transport;
    const fileAdapter = this.fileAdapter;
    const normalizedCommand = normalizeCommand(command);
    validateSandboxRunOptions(options);
    const { waitUntilRunning, ...startOptions } = options;
    const result = await transport.start({ ...startOptions, command: normalizedCommand });
    const scratchVolumeNames = scratchVolumeNamesFromRunOptions(options);

    const sandbox = new SandboxImpl({
      fileAdapter,
      metadata: result,
      sandboxId: result.sandboxId,
      transport,
      ...(scratchVolumeNames === undefined ? {} : { scratchVolumeNames }),
    });

    if (waitUntilRunning !== false) {
      await sandbox.wait({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    }

    return sandbox;
  }

  /**
   * Starts from an organization template. Omitted options preserve template
   * values unless `containerImage` is supplied.
   *
   * If creation returns an accepted sandbox but the readiness wait rejects, the
   * SDK best-effort stops it (without the caller's abort signal) and rethrows
   * the original readiness error. `waitUntilRunning: false` returns immediately
   * after accept with no automatic cleanup.
   *
   * @param templateId Non-empty organization-scoped UUID. Format validation is
   *   performed by the backend.
   */
  public async runFromTemplate(
    templateId: string,
    options: SandboxRunFromTemplateOptions = {},
  ): Promise<PublicSandbox> {
    const transport = this.transport;
    const fileAdapter = this.fileAdapter;
    validateSandboxRunFromTemplateOptions(templateId, options);
    const { command, waitUntilRunning, ...startOptions } = options;
    const result = await transport.startFromTemplate({
      ...startOptions,
      templateId,
      ...(command === undefined ? {} : { command: normalizeCommand(command) }),
    });
    const scratchVolumeNames = scratchVolumeNamesFromRunOptions(options);

    const sandbox = new SandboxImpl({
      fileAdapter,
      metadata: result,
      sandboxId: result.sandboxId,
      transport,
      ...(scratchVolumeNames === undefined ? {} : { scratchVolumeNames }),
    });

    if (waitUntilRunning !== false) {
      try {
        await sandbox.wait(waitRequestOptions(options));
      } catch (error) {
        await this.stopAfterFailedReadiness(sandbox);
        throw error;
      }
    }

    return sandbox;
  }

  public async get(sandboxId: SandboxId, options: FromIdOptions = {}): Promise<GetSandboxResult> {
    validateRequestOptions(options);
    return this.transport.get({ ...options, sandboxId });
  }

  public async fromId(sandboxId: SandboxId, options: FromIdOptions = {}): Promise<PublicSandbox> {
    const result = await this.get(sandboxId, options);

    return new SandboxImpl({
      fileAdapter: this.fileAdapter,
      metadata: result,
      sandboxId,
      transport: this.transport,
    });
  }

  public async list(options: ListSandboxesOptions = {}): Promise<ListSandboxesResult> {
    validateListSandboxesOptions(options);
    return this.transport.list(options);
  }

  public listSandboxes(options: SandboxListOptions = {}): SandboxList {
    validateListSandboxesOptions(options);
    return new SandboxList(
      (pageOptions) => this.list(pageOptions),
      (info) => this.toSandbox(info),
      options,
    );
  }

  public async listAll(options: SandboxListOptions = {}): Promise<readonly PublicSandbox[]> {
    return this.listSandboxes(options).collect();
  }

  private toSandbox(info: SandboxInfo): PublicSandbox {
    return new SandboxImpl({
      fileAdapter: this.fileAdapter,
      metadata: info,
      sandboxId: info.sandboxId,
      transport: this.transport,
    });
  }

  public async delete(sandboxId: SandboxId, options: DeleteOptions = {}): Promise<void> {
    validateDeleteOptions(options);
    const { missingOk, ...requestOptions } = options;
    await ignoreMissingSandbox(
      this.transport.delete({
        ...requestOptions,
        sandboxId,
        ...(missingOk === true ? { allowMissing: true } : {}),
      }),
      missingOk === true,
    );
  }

  public async deleteSnapshot(
    snapshotId: string,
    options: DeleteSnapshotOptions = {},
  ): Promise<void> {
    validateDeleteSnapshotOptions(options);
    const { missingOk, ...requestOptions } = options;
    await ignoreMissingSandbox(
      this.transport.deleteFileSystemSnapshot({
        ...requestOptions,
        snapshotId,
        ...(missingOk === true ? { allowMissing: true } : {}),
      }),
      missingOk === true,
    );
  }

  public async getSnapshot(
    snapshotId: string,
    options: RequestOptions = {},
  ): Promise<FileSystemSnapshotResult> {
    return getSnapshotRecord(this.transport, snapshotId, options);
  }

  public async listSnapshots(
    options: ListSnapshotsOptions = {},
  ): Promise<readonly FileSystemSnapshotResult[]> {
    return listSnapshotRecords(this.transport, options);
  }

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
    return this.disposeAfterCallback(sandbox, callback);
  }

  /**
   * Starts from an organization template and always stops the sandbox after the
   * callback returns or throws. A callback error is rethrown; a cleanup failure
   * after a successful callback is thrown; a cleanup failure after a callback
   * or readiness error does not replace that error.
   *
   * Accepts the sandbox with `waitUntilRunning: false`, then waits (unless the
   * caller disabled it) before the callback so a readiness failure still
   * `stop`s and the callback is not run.
   *
   * @param templateId Non-empty organization-scoped UUID. Format validation is
   *   performed by the backend.
   */
  public async withSandboxFromTemplate<TResult>(
    templateId: string,
    callback: WithSandboxCallback<TResult>,
    options: SandboxRunFromTemplateOptions = {},
  ): Promise<TResult> {
    validateSandboxRunFromTemplateOptions(templateId, options);
    const sandbox = await this.runFromTemplate(templateId, {
      ...options,
      waitUntilRunning: false,
    });
    return this.disposeAfterCallback(sandbox, async (handle) => {
      if (options.waitUntilRunning !== false) {
        await handle.wait(waitRequestOptions(options));
      }
      return callback(handle);
    });
  }

  private async disposeAfterCallback<TResult>(
    sandbox: PublicSandbox,
    callback: WithSandboxCallback<TResult>,
  ): Promise<TResult> {
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

  private async stopAfterFailedReadiness(sandbox: PublicSandbox): Promise<void> {
    try {
      await sandbox.stop({
        missingOk: true,
        timeoutMs: READINESS_CLEANUP_TIMEOUT_MS,
      });
    } catch {
      // Keep the original readiness error; do not wrap or replace it.
    }
  }
}

function waitRequestOptions(options: SandboxRunFromTemplateOptions): {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
} {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}
