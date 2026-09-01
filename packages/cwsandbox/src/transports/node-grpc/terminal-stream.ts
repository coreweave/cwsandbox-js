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
import type { DataPlaneRpcClient } from "./data-plane-rpc.js";
import { mapGrpcError } from "./errors.js";
import type {
  ExecStreamRequest as ProtoExecStreamRequest,
  ExecStreamResponse as ProtoExecStreamResponse,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import { linkedAbortController, toRpcOptions, withGrpcErrorMapping } from "./rpc.js";
import {
  awaitStdinReadyOrAbort,
  createStdinReadyGate,
  stdinReadyTimeoutMs,
  type StdinReadyGate,
} from "./stdin-ready-gate.js";
import {
  sendStreamingClose,
  sendStreamingResize,
  sendStreamingShellInit,
  sendStreamingStdin,
} from "./streaming-requests.js";

export async function startGrpcShell(
  streamingClient: DataPlaneRpcClient,
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
  const stdinReady = createStdinReadyGate();
  const input = createGrpcTerminalInputController(
    call,
    completeRequests,
    abortController,
    request,
    stdinReady,
  );
  const controller = createTerminalSession(request.command, input);

  await withGrpcErrorMapping(
    "Start terminal session",
    () => sendStreamingShellInit(call.requests, request),
    request.sandboxId,
  );

  void collectTerminalSession(call, controller, request, completeRequests, stdinReady);
  return controller.session;
}

async function collectTerminalSession(
  call: DuplexStreamingCall<ProtoExecStreamRequest, ProtoExecStreamResponse>,
  controller: TerminalSessionController,
  request: StartShellRequest,
  onTerminal: () => Promise<void> = async () => undefined,
  stdinReady?: StdinReadyGate,
): Promise<void> {
  let terminal = false;

  try {
    for await (const response of call.responses) {
      switch (response.message.oneofKind) {
        case "ready":
          stdinReady?.signalReady();
          await controller.dispatch({
            sessionId: "",
            type: "ready",
          });
          break;
        case "output":
          await controller.dispatch({
            data: response.message.output.data,
            type: "output",
          });
          break;
        case "exit":
          terminal = true;
          stdinReady?.signalFailed(
            new CWSandboxTransportError("Terminal session exited before stdin was ready.", {
              operation: "Terminal session",
              sandboxId: request.sandboxId,
              transport: "grpc",
            }),
          );
          await controller.dispatch({
            exitCode: response.message.exit.exitCode,
            type: "exit",
          });
          await onTerminal().catch(() => undefined);
          break;
        case "error": {
          terminal = true;
          const error = new CWSandboxTransportError(
            response.message.error.message || "Terminal session failed.",
            {
              operation: "Terminal session",
              sandboxId: request.sandboxId,
              transport: "grpc",
              transportCode: response.message.error.code,
            },
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
      const error = new CWSandboxTransportError("Terminal session ended without an exit status.", {
        operation: "Terminal session",
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
      operation: "Terminal session",
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

function createGrpcTerminalInputController(
  call: DuplexStreamingCall<ProtoExecStreamRequest, ProtoExecStreamResponse>,
  completeRequests: () => Promise<void>,
  abortController: AbortController,
  request: StartShellRequest,
  stdinReady: StdinReadyGate,
): TerminalInputController {
  const readyTimeoutMs = stdinReadyTimeoutMs(request.timeoutMs);

  return {
    async cancel(reason) {
      stdinReady.signalFailed(reason);
      abortController.abort(reason);
    },
    async close() {
      await withGrpcErrorMapping(
        "Close terminal stdin",
        async () => {
          await awaitStdinReadyOrAbort(stdinReady, readyTimeoutMs, abortController);
          await sendStreamingClose(call.requests);
          await completeRequests();
        },
        request.sandboxId,
      );
    },
    async resize(cols, rows) {
      await withGrpcErrorMapping(
        "Resize terminal",
        async () => {
          await awaitStdinReadyOrAbort(stdinReady, readyTimeoutMs, abortController);
          await sendStreamingResize(call.requests, cols, rows);
        },
        request.sandboxId,
      );
    },
    async write(data) {
      await withGrpcErrorMapping(
        "Write terminal stdin",
        async () => {
          await awaitStdinReadyOrAbort(stdinReady, readyTimeoutMs, abortController);
          await sendStreamingStdin(call.requests, data);
        },
        request.sandboxId,
      );
    },
  };
}
