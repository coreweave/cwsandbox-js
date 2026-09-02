// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type {
  CommandProcess,
  CommandProcessWithStdin,
  ProcessResult,
  TerminalSession,
} from "../../public/commands.js";
import type { LogEntryStream, LogRawStream, LogStream } from "../../public/logs.js";
import type {
  FileSystemSnapshotResult,
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  StartSandboxResult,
} from "../../public/sandbox.js";
import type { SandboxTransport } from "../../transport.js";
import type {
  CreateFileSystemSnapshotRequest,
  DeleteFileSystemSnapshotRequest,
  DeleteSandboxRequest,
  ExecRequest,
  GetFileSystemSnapshotRequest,
  GetSandboxRequest,
  ListFileSystemSnapshotsRequest,
  ListFileSystemSnapshotsResult,
  StartSandboxFromTemplateRequest,
  StartCommandRequest,
  StartShellRequest,
  StartSandboxRequest,
  StopSandboxRequest,
  StreamLogsRequest,
} from "../../transport/types.js";
import { createGrpcClients, type GrpcClients, type GrpcMetadata } from "./channel.js";
import { startGrpcCommand } from "./command-stream.js";
import { DirectDataPlane, type DirectDataPlaneLease } from "./direct-data-plane.js";
import { isGrpcUnavailable, isRunnerShardRetiringError } from "./errors.js";
import {
  CreateFileSystemSnapshotRequest as ProtoCreateFileSystemSnapshotRequest,
  DeleteFileSystemSnapshotRequest as ProtoDeleteFileSystemSnapshotRequest,
  GetFileSystemSnapshotRequest as ProtoGetFileSystemSnapshotRequest,
  ListFileSystemSnapshotsRequest as ProtoListFileSystemSnapshotsRequest,
  SandboxDataPermission,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import { startGrpcLogStream } from "./log-stream.js";
import {
  toProtoCreateFromTemplateRequest,
  toProtoCreateRequest,
  toProtoDeleteRequest,
  toProtoExecRequest,
  toProtoListSandboxesRequest,
  toSdkFileSystemSnapshot,
  toSdkGetSandboxResult,
  toSdkListSandboxesResult,
  toSdkProcessResult,
  toSdkStartSandboxResult,
} from "./mappers.js";
import { toRpcOptions, withGrpcErrorMapping } from "./rpc.js";
import { startGrpcShell } from "./terminal-stream.js";

export interface GrpcSandboxTransportOptions {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly metadata?: GrpcMetadata;
}

export class GrpcSandboxTransport implements SandboxTransport {
  /** Exposed so the factory can create a FileAdapter from the same channel. */
  public readonly clients: GrpcClients;
  public readonly directDataPlane: DirectDataPlane;
  private readonly client: GrpcClients["client"];

  public constructor(options: GrpcSandboxTransportOptions) {
    this.clients = createGrpcClients(options);
    this.client = this.clients.client;
    this.directDataPlane = new DirectDataPlane(this.client);
  }

  public async start(request: StartSandboxRequest): Promise<StartSandboxResult> {
    const response = await withGrpcErrorMapping(
      "Start sandbox",
      () =>
        this.client.createSandbox(toProtoCreateRequest(request), toRpcOptions(request)).response,
    );

    return toSdkStartSandboxResult(response);
  }

  public async startFromTemplate(
    request: StartSandboxFromTemplateRequest,
  ): Promise<StartSandboxResult> {
    const response = await withGrpcErrorMapping(
      "Create sandbox from template",
      () =>
        this.client.createSandboxFromTemplate(
          toProtoCreateFromTemplateRequest(request),
          toRpcOptions(request),
        ).response,
    );

    return toSdkStartSandboxResult(response);
  }

  public async get(request: GetSandboxRequest): Promise<GetSandboxResult> {
    const response = await withGrpcErrorMapping(
      "Get sandbox",
      () =>
        this.client.getSandbox(
          {
            sandboxId: request.sandboxId,
          },
          toRpcOptions(request),
        ).response,
      request.sandboxId,
    );

    return toSdkGetSandboxResult(response);
  }

  public async list(options: ListSandboxesOptions): Promise<ListSandboxesResult> {
    const response = await withGrpcErrorMapping(
      "List sandboxes",
      () =>
        this.client.listSandboxes(toProtoListSandboxesRequest(options), toRpcOptions(options))
          .response,
    );

    return toSdkListSandboxesResult(response);
  }

  public async delete(request: DeleteSandboxRequest): Promise<void> {
    await withGrpcErrorMapping(
      "Delete sandbox",
      () =>
        this.client.deleteSandbox(toProtoDeleteRequest(request), toRpcOptions(request)).response,
      request.sandboxId,
    );
    this.directDataPlane.discardSandbox(request.sandboxId);
  }

  public async createFileSystemSnapshot(
    request: CreateFileSystemSnapshotRequest,
  ): Promise<FileSystemSnapshotResult> {
    const response = await withGrpcErrorMapping(
      "Create file-system snapshot",
      () =>
        this.client.createFileSystemSnapshot(
          ProtoCreateFileSystemSnapshotRequest.create({
            requestId: request.requestId,
            sandboxId: request.sandboxId,
            ...(request.scratchVolumeName === undefined || request.scratchVolumeName === ""
              ? {}
              : { scratchVolumeName: request.scratchVolumeName }),
          }),
          toRpcOptions(request),
        ).response,
      request.sandboxId,
    );

    return toSdkFileSystemSnapshot(response);
  }

  public async getFileSystemSnapshot(
    request: GetFileSystemSnapshotRequest,
  ): Promise<FileSystemSnapshotResult> {
    const response = await withGrpcErrorMapping(
      "Get file-system snapshot",
      () =>
        this.client.getFileSystemSnapshot(
          ProtoGetFileSystemSnapshotRequest.create({
            fileSystemSnapshotId: request.snapshotId,
          }),
          toRpcOptions(request),
        ).response,
    );

    return toSdkFileSystemSnapshot(response);
  }

  public async listFileSystemSnapshots(
    request: ListFileSystemSnapshotsRequest,
  ): Promise<ListFileSystemSnapshotsResult> {
    const response = await withGrpcErrorMapping(
      "List file-system snapshots",
      () =>
        this.client.listFileSystemSnapshots(
          ProtoListFileSystemSnapshotsRequest.create(
            request.pageToken === undefined ? {} : { pageToken: request.pageToken },
          ),
          toRpcOptions(request),
        ).response,
    );

    return {
      snapshots: response.fileSystemSnapshots.map(toSdkFileSystemSnapshot),
      ...(response.nextPageToken === "" ? {} : { nextPageToken: response.nextPageToken }),
    };
  }

  public async deleteFileSystemSnapshot(request: DeleteFileSystemSnapshotRequest): Promise<void> {
    await withGrpcErrorMapping(
      "Delete file-system snapshot",
      () =>
        this.client.deleteFileSystemSnapshot(
          ProtoDeleteFileSystemSnapshotRequest.create({
            allowMissing: request.allowMissing === true,
            fileSystemSnapshotId: request.snapshotId,
          }),
          toRpcOptions(request),
        ).response,
    );
  }

  public async exec(request: ExecRequest): Promise<ProcessResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lease = await this.acquireDirectLease(request, SandboxDataPermission.EXEC);
      let discard = false;
      try {
        const response = await withGrpcErrorMapping(
          "Exec command",
          () =>
            (lease?.client ?? this.client).exec(toProtoExecRequest(request), toRpcOptions(request))
              .response,
          request.sandboxId,
        );
        return toSdkProcessResult(request.command, response);
      } catch (error) {
        if (lease !== undefined && isGrpcUnavailable(error)) {
          discard = true;
          await lease.discard();
        }
        if (lease !== undefined && attempt === 0 && isRunnerShardRetiringError(error)) {
          continue;
        }
        throw error;
      } finally {
        await lease?.release({ discard });
      }
    }
    throw new Error("unreachable");
  }

  public async startCommand(
    request: StartCommandRequest & { readonly stdin?: false },
  ): Promise<CommandProcess>;
  public async startCommand(
    request: StartCommandRequest & { readonly stdin: true },
  ): Promise<CommandProcessWithStdin>;
  public async startCommand(
    request: StartCommandRequest,
  ): Promise<CommandProcess | CommandProcessWithStdin> {
    const lease = await this.directDataPlane.acquire({
      dataPlaneMode: request.dataPlaneMode ?? "auto",
      permission: SandboxDataPermission.STREAM_EXEC,
      sandboxId: request.sandboxId,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    try {
      return await startGrpcCommand(
        lease?.client ?? this.client,
        request,
        lease === undefined ? undefined : (error) => settleDirectLease(lease, error),
      );
    } catch (error) {
      await settleDirectLease(lease, error);
      throw error;
    }
  }

  public async startShell(request: StartShellRequest): Promise<TerminalSession> {
    const lease = await this.directDataPlane.acquire({
      dataPlaneMode: request.dataPlaneMode ?? "auto",
      permission: SandboxDataPermission.STREAM_EXEC,
      sandboxId: request.sandboxId,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    try {
      return await startGrpcShell(
        lease?.client ?? this.client,
        request,
        lease === undefined ? undefined : (error) => settleDirectLease(lease, error),
      );
    } catch (error) {
      await settleDirectLease(lease, error);
      throw error;
    }
  }

  public async streamLogs(
    request: StreamLogsRequest,
  ): Promise<LogEntryStream | LogRawStream | LogStream> {
    const lease = await this.directDataPlane.acquire({
      dataPlaneMode: request.dataPlaneMode ?? "auto",
      permission: SandboxDataPermission.STREAM_LOGS,
      sandboxId: request.sandboxId,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    try {
      return await startGrpcLogStream(
        lease?.client ?? this.client,
        request,
        lease === undefined ? undefined : (error) => settleDirectLease(lease, error),
      );
    } catch (error) {
      await settleDirectLease(lease, error);
      throw error;
    }
  }

  public async stop(request: StopSandboxRequest): Promise<void> {
    await withGrpcErrorMapping(
      "Stop sandbox",
      () =>
        this.client.deleteSandbox(toProtoDeleteRequest(request), toRpcOptions(request)).response,
      request.sandboxId,
    );
    this.directDataPlane.discardSandbox(request.sandboxId);
  }

  private acquireDirectLease(
    request: ExecRequest,
    permission: SandboxDataPermission,
  ): Promise<DirectDataPlaneLease | undefined> {
    return this.directDataPlane.acquire({
      dataPlaneMode: request.dataPlaneMode ?? "auto",
      permission,
      sandboxId: request.sandboxId,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
  }
}

async function settleDirectLease(
  lease: DirectDataPlaneLease | undefined,
  error?: unknown,
): Promise<void> {
  if (lease === undefined) {
    return;
  }
  const discard = error !== undefined && isGrpcUnavailable(error);
  if (discard) {
    await lease.discard();
  }
  await lease.release({ discard });
}
