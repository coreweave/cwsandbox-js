// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { ignoreMissingSandbox } from "./internal/delete.js";
import { validateRequestOptions, validateStopOptions } from "./internal/validation/index.js";
import type {
  CommandInput,
  ExecOptions,
  ProcessResult,
  SandboxCommands,
  ShellOptions,
  TerminalSession,
} from "./public/commands.js";
import type { RequestOptions } from "./public/common.js";
import type { SandboxFiles } from "./public/files.js";
import type { SandboxLogs } from "./public/logs.js";
import type {
  GetSandboxResult,
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
import { createSandboxFiles } from "./runtime/files.js";
import { createSandboxLogs } from "./runtime/logs.js";
import { startShell } from "./runtime/shell.js";
import { waitForSandbox } from "./runtime/wait.js";
import type { SandboxTransport } from "./transport.js";

interface SandboxOptions {
  readonly metadata?: SandboxMetadata;
  readonly sandboxId: SandboxId;
  readonly transport: SandboxTransport;
}

export class Sandbox {
  public readonly commands: SandboxCommands;
  public readonly files: SandboxFiles;
  public readonly logs: SandboxLogs;

  public readonly sandboxId: SandboxId;

  private metadata: SandboxMetadata;
  private readonly runtime: SandboxRuntime;

  public constructor(options: SandboxOptions) {
    this.sandboxId = options.sandboxId;
    this.metadata = {
      ...cloneMetadata(options.metadata),
      sandboxId: this.sandboxId,
    };
    this.runtime = {
      sandboxId: this.sandboxId,
      streamingFallbackNotified: false,
      transport: options.transport,
    };
    this.commands = createSandboxCommands(this.runtime);
    this.files = createSandboxFiles(this.runtime);
    this.logs = createSandboxLogs(this.runtime);
  }

  public get appliedEgressMode(): string | undefined {
    return this.metadata.appliedEgressMode;
  }

  public get appliedIngressMode(): string | undefined {
    return this.metadata.appliedIngressMode;
  }

  public get exposedPorts(): readonly SandboxExposedPort[] | undefined {
    return this.metadata.exposedPorts?.map((port) => ({ ...port }));
  }

  public get profileId(): string | undefined {
    return this.metadata.profileId;
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

  public get serviceAddress(): string | undefined {
    return this.metadata.serviceAddress;
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
    return result;
  }

  public async getStatus(options: RequestOptions = {}): Promise<SandboxStatus> {
    const result = await this.inspect(options);
    return result.status;
  }

  public async shell(options: ShellOptions = {}): Promise<TerminalSession> {
    return startShell(this.runtime, options);
  }

  public async wait(options: WaitOptions = {}): Promise<Sandbox> {
    await waitForSandbox(this.runtime, options, (metadata) => {
      this.updateMetadata(metadata);
    });
    return this;
  }

  public async stop(options: StopOptions = {}): Promise<void> {
    validateStopOptions(options);

    await this.runtime.transport.stop({
      ...options,
      sandboxId: this.sandboxId,
    });
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  public async delete(options: RequestOptions = {}): Promise<void> {
    validateRequestOptions(options);

    await ignoreMissingSandbox(
      this.runtime.transport.delete({
        ...options,
        sandboxId: this.sandboxId,
      }),
    );
  }

  private updateMetadata(metadata: SandboxMetadata): void {
    this.metadata = {
      ...this.metadata,
      ...cloneMetadata(metadata),
      sandboxId: this.sandboxId,
    };
  }
}

function cloneResourceSpec(spec: SandboxResourceSpec | undefined): SandboxResourceSpec | undefined {
  return spec === undefined ? undefined : { ...spec };
}

function cloneMetadata(metadata: SandboxMetadata | undefined): Partial<SandboxMetadata> {
  if (metadata === undefined) {
    return {};
  }

  return {
    ...(metadata.appliedEgressMode === undefined
      ? {}
      : { appliedEgressMode: metadata.appliedEgressMode }),
    ...(metadata.appliedIngressMode === undefined
      ? {}
      : { appliedIngressMode: metadata.appliedIngressMode }),
    ...(metadata.exposedPorts === undefined
      ? {}
      : { exposedPorts: metadata.exposedPorts.map((port) => ({ ...port })) }),
    ...(metadata.profileId === undefined ? {} : { profileId: metadata.profileId }),
    ...(metadata.resourceLimits === undefined
      ? {}
      : { resourceLimits: { ...metadata.resourceLimits } }),
    ...(metadata.resourceRequests === undefined
      ? {}
      : { resourceRequests: { ...metadata.resourceRequests } }),
    ...(metadata.runnerGroupId === undefined ? {} : { runnerGroupId: metadata.runnerGroupId }),
    ...(metadata.runnerId === undefined ? {} : { runnerId: metadata.runnerId }),
    sandboxId: metadata.sandboxId,
    ...(metadata.serviceAddress === undefined ? {} : { serviceAddress: metadata.serviceAddress }),
    ...(metadata.startedAt === undefined ? {} : { startedAt: new Date(metadata.startedAt) }),
    ...(metadata.status === undefined ? {} : { status: metadata.status }),
    ...(metadata.statusReason === undefined ? {} : { statusReason: metadata.statusReason }),
  };
}
