// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxTransportError } from "../../errors.js";
import type { CommandProcess, ProcessResult, TerminalSession } from "../../public/commands.js";
import type { LogEntryStream, LogRawStream, LogStream } from "../../public/logs.js";
import type {
  GetSandboxResult,
  ListSandboxesOptions,
  ListSandboxesResult,
  StartSandboxResult,
} from "../../public/sandbox.js";
import type { SandboxTransport } from "../../transport.js";
import type {
  DeleteSandboxRequest,
  ExecRequest,
  GetSandboxRequest,
  ReadFileRequest,
  ReadFileResult,
  StartCommandRequest,
  StartShellRequest,
  StartSandboxRequest,
  StopSandboxRequest,
  StreamLogsRequest,
  WriteFileRequest,
} from "../../transport/types.js";
import { createGrpcClients, type GrpcClients, type GrpcMetadata } from "./channel.js";
import { startGrpcCommand } from "./command-stream.js";
import { startGrpcLogStream } from "./log-stream.js";
import {
  timeoutMsToSeconds,
  toProtoExecRequest,
  toProtoListSandboxesRequest,
  toProtoStartRequest,
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
  private readonly client: GrpcClients["client"];
  private readonly streamingClient: GrpcClients["streamingClient"];

  public constructor(options: GrpcSandboxTransportOptions) {
    const clients = createGrpcClients(options);
    this.client = clients.client;
    this.streamingClient = clients.streamingClient;
  }

  public async start(request: StartSandboxRequest): Promise<StartSandboxResult> {
    const response = await withGrpcErrorMapping(
      "Start sandbox",
      () => this.client.start(toProtoStartRequest(request), toRpcOptions(request)).response,
    );

    return toSdkStartSandboxResult(response);
  }

  public async get(request: GetSandboxRequest): Promise<GetSandboxResult> {
    const response = await withGrpcErrorMapping(
      "Get sandbox",
      () =>
        this.client.get(
          {
            maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
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
      () => this.client.list(toProtoListSandboxesRequest(options), toRpcOptions(options)).response,
    );

    return toSdkListSandboxesResult(response);
  }

  public async delete(request: DeleteSandboxRequest): Promise<void> {
    const response = await withGrpcErrorMapping(
      "Delete sandbox",
      () =>
        this.client.delete(
          {
            maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
            sandboxId: request.sandboxId,
          },
          toRpcOptions(request),
        ).response,
      request.sandboxId,
    );

    assertGrpcSuccess(response, {
      fallbackMessage: "Failed to delete sandbox.",
      operation: "Delete sandbox",
      sandboxId: request.sandboxId,
    });
  }

  public async exec(request: ExecRequest): Promise<ProcessResult> {
    const response = await withGrpcErrorMapping(
      "Exec command",
      () => this.client.exec(toProtoExecRequest(request), toRpcOptions(request)).response,
      request.sandboxId,
    );

    return toSdkProcessResult(request.command, response.result ?? emptyExecResponse());
  }

  public async startCommand(request: StartCommandRequest): Promise<CommandProcess> {
    return startGrpcCommand(this.streamingClient, request);
  }

  public async startShell(request: StartShellRequest): Promise<TerminalSession> {
    return startGrpcShell(this.streamingClient, request);
  }

  public async streamLogs(
    request: StreamLogsRequest,
  ): Promise<LogEntryStream | LogRawStream | LogStream> {
    return startGrpcLogStream(this.streamingClient, request);
  }

  public async stop(request: StopSandboxRequest): Promise<void> {
    const response = await withGrpcErrorMapping(
      "Stop sandbox",
      () =>
        this.client.stop(
          {
            fileSystemSnapshotOnStop: request.snapshotOnStop ?? false,
            gracefulShutdownSeconds: request.gracefulShutdownSeconds ?? 0,
            idempotencyKey: "",
            maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
            sandboxId: request.sandboxId,
          },
          toRpcOptions(request),
        ).response,
      request.sandboxId,
    );

    assertGrpcSuccess(response, {
      fallbackMessage: "Failed to stop sandbox.",
      operation: "Stop sandbox",
      sandboxId: request.sandboxId,
    });
  }

  public async writeFile(request: WriteFileRequest): Promise<void> {
    const response = await withGrpcErrorMapping(
      "Write file",
      () =>
        this.client.addFile(
          {
            fileContents: request.content,
            filepath: request.path,
            maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
            sandboxId: request.sandboxId,
          },
          toRpcOptions(request),
        ).response,
      { filepath: request.path, sandboxId: request.sandboxId },
    );

    assertGrpcSuccess(response, {
      fallbackMessage: "Failed to write file.",
      operation: "Write file",
      sandboxId: request.sandboxId,
    });
  }

  public async readFile(request: ReadFileRequest): Promise<ReadFileResult> {
    const response = await withGrpcErrorMapping(
      "Read file",
      () =>
        this.client.retrieveFile(
          {
            filepath: request.path,
            maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
            sandboxId: request.sandboxId,
          },
          toRpcOptions(request),
        ).response,
      { filepath: request.path, sandboxId: request.sandboxId },
    );

    assertGrpcSuccess(response, {
      fallbackMessage: "Failed to read file.",
      operation: "Read file",
      sandboxId: request.sandboxId,
    });

    return {
      content: response.fileContents,
    };
  }
}

function assertGrpcSuccess(
  response: { readonly errorMessage?: string; readonly success: boolean },
  options: {
    readonly fallbackMessage: string;
    readonly operation: string;
    readonly sandboxId: string;
  },
): void {
  if (!response.success) {
    throw new CWSandboxTransportError(response.errorMessage || options.fallbackMessage, {
      operation: options.operation,
      sandboxId: options.sandboxId,
      transport: "grpc",
    });
  }
}

function emptyExecResponse(): {
  readonly exitCode: number;
  readonly stderr: Uint8Array;
  readonly stderrBytesProduced: string;
  readonly stderrTruncated: boolean;
  readonly stdout: Uint8Array;
  readonly stdoutBytesProduced: string;
  readonly stdoutTruncated: boolean;
} {
  return {
    exitCode: -1,
    stderr: new Uint8Array(),
    stderrBytesProduced: "0",
    stderrTruncated: false,
    stdout: new Uint8Array(),
    stdoutBytesProduced: "0",
    stdoutTruncated: false,
  };
}
