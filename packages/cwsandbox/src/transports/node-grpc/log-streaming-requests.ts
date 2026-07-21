// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { StreamLogsRequest } from "../../transport/types.js";
import type {
  LogStreamRequest as ProtoLogStreamRequest,
  LogStreamResponse as ProtoLogStreamResponse,
} from "./generated/coreweave/sandbox/v1beta2/streaming.js";
import type { Timestamp } from "./generated/google/protobuf/timestamp.js";

export interface LogStreamingRequestWriter {
  complete(): Promise<void>;
  send(message: ProtoLogStreamRequest): Promise<void>;
}

export function toLogStreamInitRequest(request: StreamLogsRequest): ProtoLogStreamRequest {
  return {
    request: {
      init: {
        follow: request.follow ?? false,
        resumeOffset: request.resume === undefined ? "0" : String(request.resume.offset),
        resumeSessionId: request.resume?.sessionId ?? "",
        sandboxId: request.sandboxId,
        ...(request.sinceTime === undefined
          ? {}
          : { sinceTime: toProtoTimestamp(request.sinceTime) }),
        tailLines: request.tailLines ?? 0,
        timestamps: request.timestamps ?? false,
      },
      oneofKind: "init",
    },
  };
}

export function toLogStreamCloseRequest(): ProtoLogStreamRequest {
  return {
    request: {
      close: {},
      oneofKind: "close",
    },
  };
}

export async function sendLogStreamInit(
  writer: LogStreamingRequestWriter,
  request: StreamLogsRequest,
): Promise<void> {
  await writer.send(toLogStreamInitRequest(request));
}

export async function sendLogStreamClose(writer: LogStreamingRequestWriter): Promise<void> {
  await writer.send(toLogStreamCloseRequest());
}

export function logStreamError(response: ProtoLogStreamResponse):
  | {
      readonly code: string;
      readonly message: string;
    }
  | undefined {
  return response.response.oneofKind === "error" ? response.response.error : undefined;
}

function toProtoTimestamp(value: Date | string): Timestamp {
  const date = value instanceof Date ? value : new Date(value);
  const millis = date.getTime();
  const seconds = Math.floor(millis / 1000);

  return {
    nanos: (millis - seconds * 1000) * 1_000_000,
    seconds: String(seconds),
  };
}
