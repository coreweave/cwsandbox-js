// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { DuplexStreamingCall } from "@protobuf-ts/runtime-rpc";

import { CWSandboxTransportError } from "../../errors.js";
import type { TerminalSession } from "../../public/commands.js";
import {
  createTerminalSession,
  type TerminalInputController,
  type TerminalSessionController,
} from "../../streaming/terminal-session.js";
import type { StartShellRequest } from "../../transport/types.js";
import { mapGrpcError } from "./errors.js";
import type { GatewayStreamingServiceClient } from "./generated/coreweave/sandbox/v1beta2/streaming.client.js";
import type {
  ExecStreamRequest as ProtoExecStreamRequest,
  ExecStreamResponse as ProtoExecStreamResponse,
} from "./generated/coreweave/sandbox/v1beta2/streaming.js";
import { linkedAbortController, toRpcOptions, withGrpcErrorMapping } from "./rpc.js";
import {
  sendStreamingClose,
  sendStreamingResize,
  sendStreamingShellInit,
  sendStreamingStdin,
} from "./streaming-requests.js";

export async function startGrpcShell(
  streamingClient: GatewayStreamingServiceClient,
  request: StartShellRequest,
): Promise<TerminalSession> {
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
  const input = createGrpcTerminalInputController(call, completeRequests, abortController, request);
  const controller = createTerminalSession(request.command, input);

  await withGrpcErrorMapping(
    "Start terminal session",
    () => sendStreamingShellInit(call.requests, request),
    request.sandboxId,
  );

  void collectTerminalSession(call, controller, request, completeRequests);
  return controller.session;
}

async function collectTerminalSession(
  call: DuplexStreamingCall<ProtoExecStreamRequest, ProtoExecStreamResponse>,
  controller: TerminalSessionController,
  request: StartShellRequest,
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
            type: "output",
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
              response.response.error.message || "Terminal session failed.",
              {
                operation: "Terminal session",
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
        error: new CWSandboxTransportError("Terminal session ended without an exit status.", {
          operation: "Terminal session",
          sandboxId: request.sandboxId,
          transport: "grpc",
        }),
        type: "error",
      });
    }
  } catch (error) {
    await controller.dispatch({
      error: mapGrpcError(error, {
        operation: "Terminal session",
        sandboxId: request.sandboxId,
      }),
      type: "error",
    });
  } finally {
    await onTerminal().catch(() => undefined);
  }
}

function createGrpcTerminalInputController(
  call: DuplexStreamingCall<ProtoExecStreamRequest, ProtoExecStreamResponse>,
  completeRequests: () => Promise<void>,
  abortController: AbortController,
  request: StartShellRequest,
): TerminalInputController {
  return {
    async cancel(reason) {
      abortController.abort(reason);
    },
    async close() {
      await withGrpcErrorMapping(
        "Close terminal stdin",
        async () => {
          await sendStreamingClose(call.requests);
          await completeRequests();
        },
        request.sandboxId,
      );
    },
    async resize(cols, rows) {
      await withGrpcErrorMapping(
        "Resize terminal",
        () => sendStreamingResize(call.requests, cols, rows),
        request.sandboxId,
      );
    },
    async write(data) {
      await withGrpcErrorMapping(
        "Write terminal stdin",
        () => sendStreamingStdin(call.requests, data),
        request.sandboxId,
      );
    },
  };
}
