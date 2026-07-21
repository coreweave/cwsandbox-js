// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { DuplexStreamingCall } from "@protobuf-ts/runtime-rpc";

import { CWSandboxTransportError } from "../../errors.js";
import type { CommandProcess } from "../../public/commands.js";
import {
  createCommandProcess,
  type CommandInputController,
  type StreamingCommandProcessController,
} from "../../streaming/command-process.js";
import type { StartCommandRequest } from "../../transport/types.js";
import { mapGrpcError } from "./errors.js";
import type { GatewayStreamingServiceClient } from "./generated/coreweave/sandbox/v1beta2/streaming.client.js";
import {
  ExecStreamOutput_StreamType as ProtoExecStreamOutputStreamType,
  type ExecStreamRequest as ProtoExecStreamRequest,
  type ExecStreamResponse as ProtoExecStreamResponse,
} from "./generated/coreweave/sandbox/v1beta2/streaming.js";
import { linkedAbortController, toRpcOptions, withGrpcErrorMapping } from "./rpc.js";
import { sendStreamingClose, sendStreamingInit, sendStreamingStdin } from "./streaming-requests.js";

export async function startGrpcCommand(
  streamingClient: GatewayStreamingServiceClient,
  request: StartCommandRequest,
): Promise<CommandProcess> {
  const abortController = linkedAbortController(request.signal);
  const call = streamingClient.streamExec(
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
  const input = createGrpcCommandInputController(call, completeRequests, abortController, request);
  const commandProcessOptions =
    request.stdin === true
      ? {
          ...(request.bufferedMaxKiB === undefined
            ? {}
            : { bufferedMaxKiB: request.bufferedMaxKiB }),
          ...(request.check === undefined ? {} : { check: request.check }),
          input,
          stdin: true as const,
        }
      : {
          ...(request.bufferedMaxKiB === undefined
            ? {}
            : { bufferedMaxKiB: request.bufferedMaxKiB }),
          ...(request.check === undefined ? {} : { check: request.check }),
          input,
        };
  const controller = createCommandProcess(request.command, commandProcessOptions);

  await withGrpcErrorMapping(
    "Start streaming command",
    async () => {
      await sendStreamingInit(call.requests, request);
      if (request.stdin !== true) {
        await completeRequests();
      }
    },
    request.sandboxId,
  );

  void collectStreamingCommand(call, controller, request, completeRequests);
  return controller.process;
}

async function collectStreamingCommand(
  call: DuplexStreamingCall<ProtoExecStreamRequest, ProtoExecStreamResponse>,
  controller: StreamingCommandProcessController,
  request: StartCommandRequest,
  onTerminal: () => Promise<void> = async () => undefined,
): Promise<void> {
  let terminal = false;

  try {
    for await (const response of call.responses) {
      switch (response.response.oneofKind) {
        case "ready":
          await controller.dispatch({
            sessionId: response.response.ready.sessionId,
            type: "ready",
          });
          break;
        case "output":
          await controller.dispatch({
            data: response.response.output.data,
            type:
              response.response.output.streamType === ProtoExecStreamOutputStreamType.STDERR
                ? "stderr"
                : "stdout",
          });
          break;
        case "exit":
          terminal = true;
          await controller.dispatch({
            exitCode: response.response.exit.exitCode,
            type: "exit",
          });
          await onTerminal().catch(() => undefined);
          break;
        case "error":
          terminal = true;
          await controller.dispatch({
            error: new CWSandboxTransportError(
              response.response.error.message || "Streaming command failed.",
              {
                operation: "Streaming command",
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
      await controller.dispatch({
        error: new CWSandboxTransportError("Streaming command ended without an exit status.", {
          operation: "Streaming command",
          sandboxId: request.sandboxId,
          transport: "grpc",
        }),
        type: "error",
      });
    }
  } catch (error) {
    await controller.dispatch({
      error: mapGrpcError(error, {
        operation: "Streaming command",
        sandboxId: request.sandboxId,
      }),
      type: "error",
    });
  } finally {
    await onTerminal().catch(() => undefined);
  }
}

function createGrpcCommandInputController(
  call: DuplexStreamingCall<ProtoExecStreamRequest, ProtoExecStreamResponse>,
  completeRequests: () => Promise<void>,
  abortController: AbortController,
  request: StartCommandRequest,
): CommandInputController {
  return {
    async cancel(reason) {
      abortController.abort(reason);
    },
    async close() {
      await withGrpcErrorMapping(
        "Close streaming stdin",
        async () => {
          await sendStreamingClose(call.requests);
          await completeRequests();
        },
        request.sandboxId,
      );
    },
    async write(data) {
      await withGrpcErrorMapping(
        "Write streaming stdin",
        () => sendStreamingStdin(call.requests, data),
        request.sandboxId,
      );
    },
  };
}
