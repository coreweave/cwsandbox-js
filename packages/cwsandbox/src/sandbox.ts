// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { DEFAULT_GRACEFUL_SHUTDOWN_SECONDS } from "./defaults.js";
import { CWSandboxTimeoutError } from "./errors.js";
import { ignoreMissingSandbox } from "./internal/delete.js";
import { isSandboxNotFound } from "./internal/error-info.js";
import {
  validateDeleteOptions,
  validateRequestOptions,
  validateStopOptions,
} from "./internal/validation/index.js";
import type {
  CommandInput,
  ExecOptions,
  ProcessResult,
  SandboxCommands,
  ShellOptions,
  TerminalSession,
} from "./public/commands.js";
import type { RequestOptions } from "./public/common.js";
import type { DataPlaneMode } from "./public/data-plane.js";
import type { SandboxFiles } from "./public/files.js";
import type { SandboxLogs } from "./public/logs.js";
import type {
  HttpsEndpointStatus,
  ServiceUrl,
  TlsPassthroughEndpointStatus,
} from "./public/network.js";
import type {
  DeleteOptions,
  FileSystemSnapshotResult,
  GetSandboxResult,
  Sandbox as PublicSandbox,
  SandboxId,
  SandboxMetadata,
  SandboxResourceSpec,
  SandboxStatus,
  SandboxExposedPort,
  StopOptions,
  WaitOptions,
} from "./public/sandbox.js";
import { createSandboxCommands, execCommand } from "./runtime/commands.js";
import type { SandboxRuntime } from "./runtime/context.js";
import { FileTransfer } from "./runtime/file-transfer.js";
import { createSandboxFiles } from "./runtime/files.js";
import { createSandboxLogs } from "./runtime/logs.js";
import { startShell } from "./runtime/shell.js";
import {
  captureFileSystemSnapshot,
  type CaptureFileSystemSnapshotOptions,
} from "./runtime/snapshot.js";
import { waitForSandbox, type WaitForSandboxOptions } from "./runtime/wait.js";
import type { SandboxTransport } from "./transport.js";
import type { FileAdapter } from "./transport/file-adapter.js";

const TERMINAL_STATUSES = new Set<SandboxStatus>(["completed", "failed", "terminated"]);
const ADDRESS_RETAIN_STATUSES = new Set<SandboxStatus>(["creating", "running"]);
const STOP_OPERATION = "Stop sandbox";

interface SandboxOptions {
  readonly dataPlaneMode?: DataPlaneMode;
  readonly fileAdapter: FileAdapter;
  readonly metadata?: SandboxMetadata;
  readonly sandboxId: SandboxId;
  readonly scratchVolumeNames?: readonly string[];
  readonly transport: SandboxTransport;
}

/** Private implementation; construct via client factories only. */
export class Sandbox implements PublicSandbox {
  public readonly commands: SandboxCommands;
  public readonly files: SandboxFiles;
  public readonly logs: SandboxLogs;

  public readonly sandboxId: SandboxId;

  private metadata: SandboxMetadata;
  private readonly runtime: SandboxRuntime;
  private stopPromise: Promise<void> | undefined;

  public constructor(options: SandboxOptions) {
    const dataPlaneMode = options.dataPlaneMode;
    this.sandboxId = options.sandboxId;
    this.metadata = {
      ...cloneMetadata(options.metadata),
      sandboxId: this.sandboxId,
      ...cloneServiceDerivedFields(options.metadata),
    };
    const fileTransfer = new FileTransfer(this.sandboxId, options.fileAdapter, dataPlaneMode);
    this.runtime = {
      sandboxId: this.sandboxId,
      transport: options.transport,
      ...(dataPlaneMode === undefined ? {} : { dataPlaneMode }),
      ...(options.scratchVolumeNames === undefined
        ? {}
        : { scratchVolumeNames: options.scratchVolumeNames }),
    };
    this.commands = createSandboxCommands(this.runtime);
    this.files = createSandboxFiles(fileTransfer);
    this.logs = createSandboxLogs(this.runtime);
  }

  public get exitCode(): number | undefined {
    return this.metadata.exitCode;
  }

  public get dnsEgressNames(): readonly string[] | undefined {
    return this.metadata.dnsEgressNames === undefined
      ? undefined
      : [...this.metadata.dnsEgressNames];
  }

  public get exposedPorts(): readonly SandboxExposedPort[] | undefined {
    return this.metadata.exposedPorts?.map((port) => ({ ...port }));
  }

  public get resourceLimits(): SandboxResourceSpec | undefined {
    return cloneResourceSpec(this.metadata.resourceLimits);
  }

  public get resourceRequests(): SandboxResourceSpec | undefined {
    return cloneResourceSpec(this.metadata.resourceRequests);
  }

  public get runnerGroupId(): string | undefined {
    return this.metadata.runnerGroupId;
  }

  public get runnerId(): string | undefined {
    return this.metadata.runnerId;
  }

  public get serviceAddresses(): readonly TlsPassthroughEndpointStatus[] | undefined {
    return this.metadata.serviceAddresses?.map((service) => ({ ...service }));
  }

  public get serviceEndpoints(): readonly HttpsEndpointStatus[] | undefined {
    return this.metadata.serviceEndpoints?.map((service) => ({ ...service }));
  }

  public get serviceUrls(): readonly ServiceUrl[] | undefined {
    return this.metadata.serviceUrls?.map((service) => ({ ...service }));
  }

  public get startedAt(): Date | undefined {
    return this.metadata.startedAt === undefined ? undefined : new Date(this.metadata.startedAt);
  }

  public get status(): SandboxStatus | undefined {
    return this.metadata.status;
  }

  public get statusReason(): string | undefined {
    return this.metadata.statusReason;
  }

  public async exec(command: CommandInput, options: ExecOptions = {}): Promise<ProcessResult> {
    return execCommand(this.runtime, command, options);
  }

  public async inspect(options: RequestOptions = {}): Promise<GetSandboxResult> {
    validateRequestOptions(options);

    const result = await this.runtime.transport.get({
      ...options,
      sandboxId: this.sandboxId,
    });

    this.updateMetadata(result);
    return {
      ...result,
      ...cloneServiceDerivedFields(this.metadata),
    };
  }

  public async getStatus(options: RequestOptions = {}): Promise<SandboxStatus> {
    const result = await this.inspect(options);
    return result.status;
  }

  public async shell(options: ShellOptions = {}): Promise<TerminalSession> {
    return startShell(this.runtime, options);
  }

  public async wait(options: WaitOptions = {}): Promise<PublicSandbox> {
    // Cast preserves test-only WaitForSandboxOptions fields (e.g. initialIntervalMs)
    // when callers pass a widened object through the public WaitOptions signature.
    await waitForSandbox(this.runtime, options as WaitForSandboxOptions, (metadata) => {
      this.updateMetadata(metadata);
    });
    return this;
  }

  public async snapshot(options: RequestOptions = {}): Promise<FileSystemSnapshotResult> {
    return captureFileSystemSnapshot(
      this.runtime,
      options as CaptureFileSystemSnapshotOptions,
      (metadata) => {
        this.updateMetadata(metadata);
      },
    );
  }

  public async stop(options: StopOptions = {}): Promise<void> {
    validateStopOptions(options);

    if (this.stopPromise === undefined) {
      // First caller's lifecycle RPC options win; missingOk is applied per waiter below.
      this.stopPromise = this.runSharedStop(options);
    }

    try {
      await awaitWithRequestOptions(this.stopPromise, options, {
        operation: STOP_OPERATION,
        sandboxId: this.sandboxId,
        timeoutMessage: `Timed out waiting for sandbox '${this.sandboxId}' to reach a terminal status.`,
      });
    } catch (error) {
      if (options.missingOk === true && isSandboxNotFound(error)) {
        return;
      }
      throw error;
    }
  }

  private async runSharedStop(options: StopOptions): Promise<void> {
    const status = await this.getStatus();

    if (TERMINAL_STATUSES.has(status)) {
      return;
    }

    if (status !== "terminating") {
      await this.runtime.transport.stop({
        sandboxId: this.sandboxId,
        gracefulShutdownSeconds:
          options.gracefulShutdownSeconds ?? DEFAULT_GRACEFUL_SHUTDOWN_SECONDS,
        ...(options.missingOk === true ? { allowMissing: true } : {}),
      });
    }

    await waitForSandbox(
      this.runtime,
      {
        retryNotFoundAfterStop: true,
        targetStatus: "terminal",
        unbounded: true,
      },
      (metadata) => {
        this.updateMetadata(metadata);
      },
    );
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  public async delete(options: DeleteOptions = {}): Promise<void> {
    validateDeleteOptions(options);
    const { missingOk, ...requestOptions } = options;

    await ignoreMissingSandbox(
      this.runtime.transport.delete({
        ...requestOptions,
        sandboxId: this.sandboxId,
        ...(missingOk === true ? { allowMissing: true } : {}),
      }),
      missingOk === true,
    );
  }

  private updateMetadata(metadata: SandboxMetadata): void {
    const serviceAddresses = mergeServiceAddresses(this.metadata, metadata);
    const { serviceAddresses: _ignored, ...metadataWithoutAddresses } = metadata;
    this.metadata = {
      ...cloneMetadata(this.metadata),
      ...cloneMetadata(metadata),
      sandboxId: this.sandboxId,
      ...cloneServiceDerivedFields(metadataWithoutAddresses),
      ...(serviceAddresses === undefined ? {} : { serviceAddresses }),
    };
  }
}

function awaitWithRequestOptions(
  promise: Promise<void>,
  options: RequestOptions,
  details: {
    readonly operation: string;
    readonly sandboxId: string;
    readonly timeoutMessage: string;
  },
): Promise<void> {
  if (options.timeoutMs === undefined && options.signal === undefined) {
    return promise;
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => {
      try {
        options.signal?.throwIfAborted();
      } catch (error) {
        settle(() => reject(error));
      }
    };

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        settle(() =>
          reject(
            new CWSandboxTimeoutError(details.timeoutMessage, {
              operation: details.operation,
              sandboxId: details.sandboxId,
            }),
          ),
        );
      }, options.timeoutMs);
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }

    void promise.then(
      () => {
        settle(() => resolve());
      },
      (error: unknown) => {
        settle(() => reject(error));
      },
    );
  });
}

function cloneResourceSpec(spec: SandboxResourceSpec | undefined): SandboxResourceSpec | undefined {
  return spec === undefined ? undefined : { ...spec };
}

function cloneExposedPorts(
  ports: readonly SandboxExposedPort[] | undefined,
): readonly SandboxExposedPort[] | undefined {
  return ports === undefined ? undefined : ports.map((port) => ({ ...port }));
}

function cloneServiceUrls(
  urls: readonly ServiceUrl[] | undefined,
): readonly ServiceUrl[] | undefined {
  return urls === undefined ? undefined : urls.map((service) => ({ ...service }));
}

function cloneServiceEndpoints(
  endpoints: readonly HttpsEndpointStatus[] | undefined,
): readonly HttpsEndpointStatus[] | undefined {
  return endpoints === undefined ? undefined : endpoints.map((service) => ({ ...service }));
}

function cloneServiceAddresses(
  addresses: readonly TlsPassthroughEndpointStatus[] | undefined,
): readonly TlsPassthroughEndpointStatus[] | undefined {
  return addresses === undefined ? undefined : addresses.map((service) => ({ ...service }));
}

function cloneServiceDerivedFields(
  metadata: SandboxMetadata | undefined,
): Pick<
  SandboxMetadata,
  "exposedPorts" | "serviceAddresses" | "serviceEndpoints" | "serviceUrls"
> {
  const exposedPorts = cloneExposedPorts(metadata?.exposedPorts);
  const serviceAddresses = cloneServiceAddresses(metadata?.serviceAddresses);
  const serviceEndpoints = cloneServiceEndpoints(metadata?.serviceEndpoints);
  const serviceUrls = cloneServiceUrls(metadata?.serviceUrls);
  return {
    ...(exposedPorts === undefined ? {} : { exposedPorts }),
    ...(serviceAddresses === undefined ? {} : { serviceAddresses }),
    ...(serviceEndpoints === undefined ? {} : { serviceEndpoints }),
    ...(serviceUrls === undefined ? {} : { serviceUrls }),
  };
}

function serviceAddressKey(port: number, name: string | undefined): string {
  return `${String(port)}\0${name ?? ""}`;
}

function mergeServiceAddresses(
  previous: SandboxMetadata,
  incoming: SandboxMetadata,
): readonly TlsPassthroughEndpointStatus[] | undefined {
  if (incoming.status === undefined || !ADDRESS_RETAIN_STATUSES.has(incoming.status)) {
    return undefined;
  }

  const livePorts = incoming.exposedPorts;
  if (livePorts === undefined && incoming.serviceAddresses === undefined) {
    return undefined;
  }

  const live = new Set((livePorts ?? []).map((port) => serviceAddressKey(port.port, port.name)));
  for (const entry of incoming.serviceAddresses ?? []) {
    live.add(serviceAddressKey(entry.port, entry.name));
  }

  const byKey = new Map<string, TlsPassthroughEndpointStatus>();
  for (const entry of previous.serviceAddresses ?? []) {
    const key = serviceAddressKey(entry.port, entry.name);
    if (live.has(key)) {
      byKey.set(key, entry);
    }
  }
  for (const entry of incoming.serviceAddresses ?? []) {
    byKey.set(serviceAddressKey(entry.port, entry.name), { ...entry });
  }

  const merged: TlsPassthroughEndpointStatus[] = [];
  const seen = new Set<string>();
  for (const port of livePorts ?? []) {
    const key = serviceAddressKey(port.port, port.name);
    const entry = byKey.get(key);
    if (entry !== undefined && !seen.has(key)) {
      merged.push({ ...entry });
      seen.add(key);
    }
  }
  for (const entry of incoming.serviceAddresses ?? []) {
    const key = serviceAddressKey(entry.port, entry.name);
    if (!seen.has(key)) {
      merged.push({ ...entry });
      seen.add(key);
    }
  }

  return merged.length === 0 ? undefined : merged;
}

function cloneMetadata(metadata: SandboxMetadata | undefined): Partial<SandboxMetadata> {
  if (metadata === undefined) {
    return {};
  }

  return {
    ...(metadata.dnsEgressNames === undefined
      ? {}
      : { dnsEgressNames: [...metadata.dnsEgressNames] }),
    ...(metadata.exitCode === undefined ? {} : { exitCode: metadata.exitCode }),
    ...(metadata.resourceLimits === undefined
      ? {}
      : { resourceLimits: { ...metadata.resourceLimits } }),
    ...(metadata.resourceRequests === undefined
      ? {}
      : { resourceRequests: { ...metadata.resourceRequests } }),
    ...(metadata.runnerGroupId === undefined ? {} : { runnerGroupId: metadata.runnerGroupId }),
    ...(metadata.runnerId === undefined ? {} : { runnerId: metadata.runnerId }),
    sandboxId: metadata.sandboxId,
    ...(metadata.startedAt === undefined ? {} : { startedAt: new Date(metadata.startedAt) }),
    ...(metadata.status === undefined ? {} : { status: metadata.status }),
    ...(metadata.statusReason === undefined ? {} : { statusReason: metadata.statusReason }),
  };
}
