// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { commandForWorkingDirectory } from "../../internal/commands.js";
import type { StartCommandRequest, StartShellRequest } from "../../transport/types.js";
import { ExecStreamRequest } from "./generated/coreweave/sandbox/v1/sandbox.js";

export interface StreamingRequestWriter {
  complete(): Promise<void>;
  send(message: ExecStreamRequest): Promise<void>;
}

export function toStreamingInitRequest(request: StartCommandRequest): ExecStreamRequest {
  return ExecStreamRequest.create({
    message: {
      init: {
        command: commandForWorkingDirectory(request.command, request.cwd),
        container: "",
        env: {},
        sandboxId: request.sandboxId,
        tty: false,
        ttyHeight: 0,
        ttyWidth: 0,
      },
      oneofKind: "init",
    },
  });
}

export function toStreamingShellInitRequest(request: StartShellRequest): ExecStreamRequest {
  return ExecStreamRequest.create({
    message: {
      init: {
        command: [...request.command],
        container: "",
        env: {},
        sandboxId: request.sandboxId,
        tty: true,
        ttyHeight: request.rows ?? 0,
        ttyWidth: request.cols ?? 0,
      },
      oneofKind: "init",
    },
  });
}

export function toStreamingStdinRequest(data: Uint8Array): ExecStreamRequest {
  return ExecStreamRequest.create({
    message: {
      oneofKind: "stdin",
      stdin: data,
    },
  });
}

export function toStreamingCloseRequest(): ExecStreamRequest {
  return ExecStreamRequest.create({
    message: {
      close: {},
      oneofKind: "close",
    },
  });
}

export function toStreamingResizeRequest(cols: number, rows: number): ExecStreamRequest {
  return ExecStreamRequest.create({
    message: {
      oneofKind: "resize",
      resize: {
        height: rows,
        width: cols,
      },
    },
  });
}

export async function sendStreamingInit(
  writer: StreamingRequestWriter,
  request: StartCommandRequest,
): Promise<void> {
  await writer.send(toStreamingInitRequest(request));
}

export async function sendStreamingShellInit(
  writer: StreamingRequestWriter,
  request: StartShellRequest,
): Promise<void> {
  await writer.send(toStreamingShellInitRequest(request));
}

export async function sendStreamingResize(
  writer: StreamingRequestWriter,
  cols: number,
  rows: number,
): Promise<void> {
  await writer.send(toStreamingResizeRequest(cols, rows));
}

export async function sendStreamingStdin(
  writer: StreamingRequestWriter,
  data: Uint8Array,
): Promise<void> {
  await writer.send(toStreamingStdinRequest(data));
}

export async function sendStreamingClose(writer: StreamingRequestWriter): Promise<void> {
  await writer.send(toStreamingCloseRequest());
}
