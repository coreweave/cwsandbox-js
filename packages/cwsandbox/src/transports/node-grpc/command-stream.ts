// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { DuplexStreamingCall } from "@protobuf-ts/runtime-rpc";

import {
  CWSandboxStreamBackpressureError,
  CWSandboxStreamTruncatedError,
  CWSandboxTransportError,
} from "../../errors.js";
import { STREAM_BACKPRESSURE, STREAM_TRUNCATED } from "../../internal/error-info.js";
import type { InternalCommandProcess } from "../../internal/start-command-options.js";
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
import {
  awaitStdinReadyOrAbort,
  createStdinReadyGate,
  stdinReadyTimeoutMs,
  type StdinReadyGate,
} from "./stdin-ready-gate.js";
import { sendStreamingClose, sendStreamingInit, sendStreamingStdin } from "./streaming-requests.js";

export async function startGrpcCommand(
  streamingClient: GatewayStreamingServiceClient,
  request: StartCommandRequest,
): Promise<InternalCommandProcess> {
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
  const stdinReady = request.stdin === true ? createStdinReadyGate() : undefined;
  const input = createGrpcCommandInputController(
    call,
    completeRequests,
    abortController,
    request,
    stdinReady,
  );
  const sharedProcessOptions = {
    ...(request.binaryOutput === undefined ? {} : { binaryOutput: request.binaryOutput }),
    ...(request.bufferedMaxKiB === undefined ? {} : { bufferedMaxKiB: request.bufferedMaxKiB }),
    ...(request.check === undefined ? {} : { check: request.check }),
    ...(request.streamStdoutOnly === undefined
      ? {}
      : { streamStdoutOnly: request.streamStdoutOnly }),
  };
  const commandProcessOptions =
    request.stdin === true
      ? {
          ...sharedProcessOptions,
          input,
          stdin: true as const,
        }
      : {
          ...sharedProcessOptions,
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

  void collectStreamingCommand(call, controller, request, completeRequests, stdinReady);
  return controller.process;
}

async function collectStreamingCommand(
  call: DuplexStreamingCall<ProtoExecStreamRequest, ProtoExecStreamResponse>,
  controller: StreamingCommandProcessController,
  request: StartCommandRequest,
  onTerminal: () => Promise<void> = async () => undefined,
  stdinReady?: StdinReadyGate,
): Promise<void> {
  let terminal = false;

  try {
    for await (const response of call.responses) {
      switch (response.response.oneofKind) {
        case "ready":
          stdinReady?.signalReady();
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
          stdinReady?.signalFailed(
            new CWSandboxTransportError("Streaming command exited before stdin was ready.", {
              operation: "Streaming command",
              sandboxId: request.sandboxId,
              transport: "grpc",
            }),
          );
          await controller.dispatch({
            exitCode: response.response.exit.exitCode,
            type: "exit",
          });
          await onTerminal().catch(() => undefined);
          break;
        case "error": {
          terminal = true;
          const error = mapExecStreamError(
            response.response.error.code,
            response.response.error.message || "Streaming command failed.",
            request.sandboxId,
          );
          stdinReady?.signalFailed(error);
          await controller.dispatch({
            error,
            type: "error",
          });
          await onTerminal().catch(() => undefined);
          break;
        }
        case undefined:
          break;
      }
    }

    await call.status;
    if (!terminal) {
      const error = new CWSandboxTransportError("Streaming command ended without an exit status.", {
        operation: "Streaming command",
        sandboxId: request.sandboxId,
        transport: "grpc",
      });
      stdinReady?.signalFailed(error);
      await controller.dispatch({
        error,
        type: "error",
      });
    }
  } catch (error) {
    const mapped = mapGrpcError(error, {
      operation: "Streaming command",
      sandboxId: request.sandboxId,
    });
    stdinReady?.signalFailed(mapped);
    await controller.dispatch({
      error: mapped,
      type: "error",
    });
  } finally {
    await onTerminal().catch(() => undefined);
  }
}

const BACKPRESSURE_MESSAGE =
  "Output stream ended early because it was not being read fast enough to " +
  "keep up with the command's output; some output was lost. If you do slow " +
  "work between reads, move it off the read loop (drain into a fast local " +
  "sink such as a file, then process afterward) and use files.readStream / " +
  "files.writeStream for large files. If the destination is itself slow and " +
  "cannot keep up no matter how tight the loop, split the work into smaller " +
  "transfers. Retrying the same pattern will hit this again.";

const TRUNCATED_MESSAGE =
  "The command completed but some of its output was lost in transit, " +
  "so the output you received is incomplete. For large output, write " +
  "it to a file and retrieve the file (files.readStream) instead " +
  "of streaming over stdout. Re-running may truncate again and may " +
  "have side effects, so re-run only if the command is idempotent.";

/** Exported for unit tests that assert stream codes are not remasked. */
export function mapExecStreamError(
  code: string,
  message: string,
  sandboxId: string | undefined,
): Error {
  if (code === STREAM_BACKPRESSURE) {
    return new CWSandboxStreamBackpressureError(BACKPRESSURE_MESSAGE, {
      streamCode: STREAM_BACKPRESSURE,
    });
  }

  if (code === STREAM_TRUNCATED) {
    return new CWSandboxStreamTruncatedError(TRUNCATED_MESSAGE, {
      streamCode: STREAM_TRUNCATED,
    });
  }

  return new CWSandboxTransportError(message, {
    operation: "Streaming command",
    ...(sandboxId === undefined ? {} : { sandboxId }),
    transport: "grpc",
    transportCode: code,
  });
}

function createGrpcCommandInputController(
  call: DuplexStreamingCall<ProtoExecStreamRequest, ProtoExecStreamResponse>,
  completeRequests: () => Promise<void>,
  abortController: AbortController,
  request: StartCommandRequest,
  stdinReady: StdinReadyGate | undefined,
): CommandInputController {
  const readyTimeoutMs = stdinReadyTimeoutMs(request.timeoutMs);

  return {
    async cancel(reason) {
      stdinReady?.signalFailed(reason);
      abortController.abort(reason);
    },
    async close() {
      await withGrpcErrorMapping(
        "Close streaming stdin",
        async () => {
          await awaitStdinReadyOrAbort(stdinReady, readyTimeoutMs, abortController);
          await sendStreamingClose(call.requests);
          await completeRequests();
        },
        request.sandboxId,
      );
    },
    async write(data) {
      await withGrpcErrorMapping(
        "Write streaming stdin",
        async () => {
          await awaitStdinReadyOrAbort(stdinReady, readyTimeoutMs, abortController);
          await sendStreamingStdin(call.requests, data);
        },
        request.sandboxId,
      );
    },
  };
}
