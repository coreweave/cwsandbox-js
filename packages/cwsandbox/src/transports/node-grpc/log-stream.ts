// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { DuplexStreamingCall } from "@protobuf-ts/runtime-rpc";

import { CWSandboxTransportError } from "../../errors.js";
import type { LogEntryStream, LogRawStream, LogStream } from "../../public/logs.js";
import { createLogStream, type LogStreamController } from "../../streaming/log-stream.js";
import type { StreamLogsRequest } from "../../transport/types.js";
import { mapGrpcError } from "./errors.js";
import type { GatewayStreamingServiceClient } from "./generated/coreweave/sandbox/v1beta2/streaming.client.js";
import type {
  LogStreamRequest as ProtoLogStreamRequest,
  LogStreamResponse as ProtoLogStreamResponse,
} from "./generated/coreweave/sandbox/v1beta2/streaming.js";
import { sendLogStreamClose, sendLogStreamInit } from "./log-streaming-requests.js";
import { linkedAbortController, toRpcOptions, withGrpcErrorMapping } from "./rpc.js";

export async function startGrpcLogStream(
  streamingClient: GatewayStreamingServiceClient,
  request: StreamLogsRequest,
): Promise<LogEntryStream | LogRawStream | LogStream> {
  const abortController = linkedAbortController(request.signal);
  const call = streamingClient.streamLogs(
    toRpcOptions({
      ...request,
      signal: abortController.signal,
    }),
  );
  let requestsCompleted = false;
  const completeRequests = async (): Promise<void> => {
    if (requestsCompleted) {
      return;
    }

    requestsCompleted = true;
    await call.requests.complete();
  };
  const controls = {
    async cancel(reason: unknown) {
      abortController.abort(reason);
    },
    async close() {
      await withGrpcErrorMapping(
        "Close log stream",
        async () => {
          await sendLogStreamClose(call.requests);
          await completeRequests();
        },
        request.sandboxId,
      );
    },
  };
  const controller = createLogStream(request.mode, controls);

  await withGrpcErrorMapping(
    "Stream logs",
    async () => {
      await sendLogStreamInit(call.requests, request);
      if (request.follow !== true) {
        await completeRequests();
      }
    },
    request.sandboxId,
  );

  void collectLogStream(call, controller, request, completeRequests);
  return controller.stream;
}

async function collectLogStream(
  call: DuplexStreamingCall<ProtoLogStreamRequest, ProtoLogStreamResponse>,
  controller: LogStreamController<LogEntryStream | LogRawStream | LogStream>,
  request: StreamLogsRequest,
  onTerminal: () => Promise<void>,
): Promise<void> {
  let terminal = false;

  try {
    for await (const response of call.responses) {
      switch (response.response.oneofKind) {
        case "data":
          await controller.dispatch({
            data: response.response.data.data,
            offset: response.response.data.offset,
            sessionId: response.response.data.sessionId,
            ...(response.response.data.timestamp === undefined
              ? {}
              : { timestamp: response.response.data.timestamp }),
            type: "data",
          });
          break;
        case "complete":
          terminal = true;
          await controller.dispatch({ type: "complete" });
          await onTerminal().catch(() => undefined);
          break;
        case "error":
          terminal = true;
          await controller.dispatch({
            error: new CWSandboxTransportError(
              response.response.error.message || "Log stream failed.",
              {
                operation: "Stream logs",
                sandboxId: request.sandboxId,
                transport: "grpc",
                transportCode: response.response.error.code,
              },
            ),
            type: "error",
          });
          await onTerminal().catch(() => undefined);
          break;
        case undefined:
          break;
      }
    }

    await call.status;
    if (!terminal) {
      await controller.dispatch({ type: "complete" });
    }
  } catch (error) {
    await controller.dispatch({
      error: mapGrpcError(error, {
        operation: "Stream logs",
        sandboxId: request.sandboxId,
      }),
      type: "error",
    });
  } finally {
    await onTerminal().catch(() => undefined);
  }
}
