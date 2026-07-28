// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type {
  CommandInput,
  ExecOptions,
  ProcessResult,
  SandboxCommands,
  ShellOptions,
  TerminalSession,
} from "./commands.js";
import type { RequestOptions, Seconds } from "./common.js";
import type { MountedFiles, SandboxFiles } from "./files.js";
import type { SandboxLogs } from "./logs.js";
import type { NetworkOptions, PortInput } from "./network.js";
import type { ResourceOptions, ResourceSpec } from "./resources.js";
import type { Secrets } from "./secrets.js";

export type EnvironmentVariables = Readonly<Record<string, string>>;
export type FromIdOptions = RequestOptions;
export type SandboxAnnotations = Readonly<Record<string, string>>;
export type SandboxId = string;
export type SandboxTag = string;

export type SandboxStatus =
  | "pending"
  | "creating"
  | "running"
  | "paused"
  | "terminating"
  | "completed"
  | "failed"
  | "terminated"
  | "unspecified";

export type WaitTargetStatus = "completed" | "paused" | "running" | "terminal";

export interface WaitOptions extends RequestOptions {
  readonly targetStatus?: WaitTargetStatus;
}

export interface SandboxRunOptions extends RequestOptions {
  readonly annotations?: SandboxAnnotations;
  readonly containerImage?: string;
  readonly environmentVariables?: EnvironmentVariables;
  readonly maxLifetimeSeconds?: Seconds;
  readonly mountedFiles?: MountedFiles;
  readonly network?: NetworkOptions;
  readonly ports?: readonly PortInput[];
  readonly profileIds?: readonly string[];
  readonly profileNames?: readonly string[];
  readonly resources?: ResourceOptions;
  readonly runnerIds?: readonly string[];
  /**
   * Secret-store references to resolve server-side and inject as environment variables.
   *
   * Do not put secret values in `environmentVariables`, annotations, or tags.
   */
  readonly secrets?: Secrets;
  readonly tags?: readonly SandboxTag[];
  /**
   * Wait for the sandbox to reach `running` before resolving creation helpers.
   *
   * Defaults to `true`. Set to `false` only when you need a handle as soon as
   * the backend accepts the start request.
   */
  readonly waitUntilRunning?: boolean;
}

export interface StopOptions extends RequestOptions {
  readonly gracefulShutdownSeconds?: Seconds;
  /**
   * When true, treat a missing sandbox (gRPC `NOT_FOUND` or trusted
   * `CWSANDBOX_SANDBOX_NOT_FOUND`) as success. Defaults to `false`.
   */
  readonly missingOk?: boolean;
}

export interface DeleteOptions extends RequestOptions {
  /**
   * When true, treat a missing sandbox (gRPC `NOT_FOUND` or trusted
   * `CWSANDBOX_SANDBOX_NOT_FOUND`) as success. Defaults to `false`.
   */
  readonly missingOk?: boolean;
}

export interface ListSandboxesOptions extends RequestOptions {
  readonly includeStopped?: boolean;
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly profileIds?: readonly string[];
  readonly profileNames?: readonly string[];
  readonly runnerIds?: readonly string[];
  readonly status?: SandboxStatus;
  readonly tags?: readonly SandboxTag[];
}

/**
 * Options for `SandboxClient.listSandboxes()` and `SandboxClient.listAll()`.
 *
 * Omits `pageToken` because the helper owns pagination. `timeoutMs` is a
 * wall-clock budget across all pages (default 300s), not a per-page RPC timeout.
 */
export type SandboxListOptions = Omit<ListSandboxesOptions, "pageToken">;

export interface SandboxExposedPort {
  readonly name?: string;
  readonly port: number;
  readonly protocol?: string;
}

export type SandboxResourceSpec = ResourceSpec;

export interface SandboxMetadata {
  readonly appliedEgressMode?: string;
  readonly appliedIngressMode?: string;
  readonly exposedPorts?: readonly SandboxExposedPort[];
  readonly profileId?: string;
  readonly resourceLimits?: SandboxResourceSpec;
  readonly resourceRequests?: SandboxResourceSpec;
  readonly runnerGroupId?: string;
  readonly runnerId?: string;
  readonly sandboxId: SandboxId;
  readonly serviceAddress?: string;
  readonly startedAt?: Date;
  readonly status?: SandboxStatus;
  readonly statusReason?: string;
}

export interface SandboxInfo extends SandboxMetadata {
  readonly status: SandboxStatus;
}

export interface ListSandboxesResult {
  readonly nextPageToken?: string;
  readonly sandboxes: readonly SandboxInfo[];
}

export interface StartSandboxResult extends SandboxMetadata {}

export interface GetSandboxResult extends SandboxMetadata {
  readonly status: SandboxStatus;
}

/** Public instance interface returned by client factories. */
export interface Sandbox {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;
  readonly logs: SandboxLogs;
  readonly sandboxId: SandboxId;
  readonly appliedEgressMode: string | undefined;
  readonly appliedIngressMode: string | undefined;
  readonly exposedPorts: readonly SandboxExposedPort[] | undefined;
  readonly profileId: string | undefined;
  readonly resourceLimits: SandboxResourceSpec | undefined;
  readonly resourceRequests: SandboxResourceSpec | undefined;
  readonly runnerGroupId: string | undefined;
  readonly runnerId: string | undefined;
  readonly serviceAddress: string | undefined;
  readonly startedAt: Date | undefined;
  readonly status: SandboxStatus | undefined;
  readonly statusReason: string | undefined;
  exec(command: CommandInput, options?: ExecOptions): Promise<ProcessResult>;
  inspect(options?: RequestOptions): Promise<GetSandboxResult>;
  getStatus(options?: RequestOptions): Promise<SandboxStatus>;
  shell(options?: ShellOptions): Promise<TerminalSession>;
  wait(options?: WaitOptions): Promise<Sandbox>;
  stop(options?: StopOptions): Promise<void>;
  delete(options?: DeleteOptions): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
