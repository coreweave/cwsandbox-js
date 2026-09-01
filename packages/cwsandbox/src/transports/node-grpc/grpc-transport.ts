// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";

import { CWSandboxUnavailableError } from "../../errors.js";
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
import type {
  DataPlanePermission,
  PrepareDataPlaneCall,
  PrepareDataPlaneCallOptions,
  PreparedDataPlaneCall,
} from "./data-plane-rpc.js";
import {
  connectSandboxFromGatewayClient,
  createDirectPreparedCall,
  createGatewayPreparedCall,
  DirectDataPlaneClient,
  DirectDataPlanePermissionUnavailable,
  DirectDataPlaneUnavailable,
  isDirectStrict,
  isGatewayOnly,
  requestTimeoutMs,
} from "./direct.js";
import { mapGrpcError } from "./errors.js";
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
  public readonly prepareDataPlaneCall: PrepareDataPlaneCall;
  private readonly client: GrpcClients["client"];
  private readonly directClients = new Map<string, DirectDataPlaneClient>();

  public constructor(options: GrpcSandboxTransportOptions) {
    this.clients = createGrpcClients(options);
    this.client = this.clients.client;
    this.prepareDataPlaneCall = (sandboxId, permission, requestOptions) =>
      this.prepare(sandboxId, permission, requestOptions);
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
    const prepared = await this.prepare(request.sandboxId, SandboxDataPermission.EXEC, request);
    try {
      const response = await withGrpcErrorMapping(
        "Exec command",
        () =>
          prepared.client.exec(toProtoExecRequest(request), {
            ...prepared.rpcOptions,
            ...toRpcOptions(request),
          }).response,
        request.sandboxId,
      );
      return toSdkProcessResult(request.command, response);
    } finally {
      prepared.release();
    }
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
    const prepared = await this.prepare(
      request.sandboxId,
      SandboxDataPermission.STREAM_EXEC,
      request,
    );
    try {
      const process = await startGrpcCommand(prepared.client, request);
      prepared.releaseWhenDone(process.wait().catch(() => undefined));
      return process;
    } catch (error) {
      prepared.release();
      throw error;
    }
  }

  public async startShell(request: StartShellRequest): Promise<TerminalSession> {
    const prepared = await this.prepare(
      request.sandboxId,
      SandboxDataPermission.STREAM_EXEC,
      request,
    );
    try {
      const session = await startGrpcShell(prepared.client, request);
      prepared.releaseWhenDone(session.wait().catch(() => undefined));
      return session;
    } catch (error) {
      prepared.release();
      throw error;
    }
  }

  public async streamLogs(
    request: StreamLogsRequest,
  ): Promise<LogEntryStream | LogRawStream | LogStream> {
    const prepared = await this.prepare(
      request.sandboxId,
      SandboxDataPermission.STREAM_LOGS,
      request,
    );
    try {
      return await startGrpcLogStream(prepared.client, request, () => {
        prepared.release();
      });
    } catch (error) {
      prepared.release();
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
    this.directClients.get(request.sandboxId)?.close();
    this.directClients.delete(request.sandboxId);
  }

  private async prepare(
    sandboxId: string,
    permission: DataPlanePermission,
    options: PrepareDataPlaneCallOptions = {},
  ): Promise<PreparedDataPlaneCall> {
    if (!isGatewayOnly(options.dataPlaneMode)) {
      try {
        let client = this.directClients.get(sandboxId);
        if (client === undefined) {
          client = new DirectDataPlaneClient(connectSandboxFromGatewayClient(this.client));
          this.directClients.set(sandboxId, client);
        }
        const lease = await client.acquire({
          permission,
          requestTimeoutMs: requestTimeoutMs(options.timeoutMs),
          sandboxId,
          strict: isDirectStrict(options.dataPlaneMode),
        });
        return createDirectPreparedCall(lease);
      } catch (error) {
        if (error instanceof RpcError) {
          throw mapGrpcError(error, {
            operation: "Connect to sandbox data plane",
            sandboxId,
          });
        }
        if (
          error instanceof DirectDataPlaneUnavailable ||
          error instanceof DirectDataPlanePermissionUnavailable
        ) {
          if (isDirectStrict(options.dataPlaneMode)) {
            throw new CWSandboxUnavailableError(
              `Direct data-plane access is unavailable for sandbox ${sandboxId}: ${error.message}`,
              {
                cause: error,
                operation: "Connect to sandbox data plane",
                sandboxId,
                transport: "grpc",
              },
            );
          }
        } else {
          throw error;
        }
      }
    }

    return createGatewayPreparedCall(this.client, options);
  }
}
