// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { ServerStreamingCall } from "@protobuf-ts/runtime-rpc";

import { CWSandboxTransportError } from "../../errors.js";
import type { LogEntryStream, LogRawStream, LogStream } from "../../public/logs.js";
import { createLogStream, type LogStreamController } from "../../streaming/log-stream.js";
import type { StreamLogsRequest } from "../../transport/types.js";
import { mapGrpcError } from "./errors.js";
import type { SandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";
import type {
  LogEntry as ProtoLogEntry,
  StreamLogsRequest as ProtoStreamLogsRequest,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import { toProtoStreamLogsRequest } from "./mappers.js";
import { linkedAbortController, toRpcOptions, withGrpcErrorMapping } from "./rpc.js";

export async function startGrpcLogStream(
  client: SandboxServiceClient,
  request: StreamLogsRequest,
): Promise<LogEntryStream | LogRawStream | LogStream> {
  const abortController = linkedAbortController(request.signal);
  const callerAbort = { aborted: false };
  const call = client.streamLogs(
    toProtoStreamLogsRequest(request),
    toRpcOptions({
      ...request,
      signal: abortController.signal,
    }),
  );
  const controls = {
    async cancel(reason: unknown) {
      callerAbort.aborted = true;
      abortController.abort(reason);
    },
    async close() {
      callerAbort.aborted = true;
      abortController.abort();
    },
  };
  const controller = createLogStream(request.mode, controls);

  await withGrpcErrorMapping("Stream logs", async () => undefined, request.sandboxId);

  void collectLogStream(call, controller, request, callerAbort);
  return controller.stream;
}

async function collectLogStream(
  call: ServerStreamingCall<ProtoStreamLogsRequest, ProtoLogEntry>,
  controller: LogStreamController<LogEntryStream | LogRawStream | LogStream>,
  request: StreamLogsRequest,
  callerAbort: { aborted: boolean },
): Promise<void> {
  let terminal = false;

  try {
    for await (const entry of call.responses) {
      if (entry.error !== undefined) {
        terminal = true;
        if (callerAbort.aborted) {
          return;
        }
        await controller.dispatch({
          error: new CWSandboxTransportError(entry.error.message || "Log stream failed.", {
            operation: "Stream logs",
            sandboxId: request.sandboxId,
            transport: "grpc",
            transportCode: entry.error.code,
          }),
          type: "error",
        });
        return;
      }

      await controller.dispatch({
        data: entry.data,
        offset: entry.nextLogOffset,
        sessionId: entry.logSessionId,
        ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
        type: "data",
      });
    }

    await call.status;
    if (!terminal && !callerAbort.aborted) {
      await controller.dispatch({ type: "complete" });
    }
  } catch (error) {
    if (callerAbort.aborted) {
      return;
    }
    await controller.dispatch({
      error: mapGrpcError(error, {
        operation: "Stream logs",
        sandboxId: request.sandboxId,
      }),
      type: "error",
    });
  }
}
