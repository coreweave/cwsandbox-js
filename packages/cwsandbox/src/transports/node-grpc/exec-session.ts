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
import type { Command } from "../../public/commands.js";
import type { RequestOptions } from "../../public/common.js";
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

/** Raw frame emitted by an exec session. */
export type ExecFrame =
  | { readonly sessionId: string; readonly type: "ready" }
  | { readonly data: Uint8Array; readonly type: "stdout" }
  | { readonly data: Uint8Array; readonly type: "stderr" }
  | { readonly exitCode: number; readonly type: "exit" }
  | { readonly error: unknown; readonly type: "error" };

/** Controller returned to callers who want to send stdin frames. */
export interface ExecSessionInputController {
  cancel(reason: unknown): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
}

/** An open exec session with raw frame delivery. */
export interface ExecSession {
  /** Async iterable of raw frames (ready/stdout/stderr/exit/error). */
  readonly frames: AsyncIterable<ExecFrame>;
  /** Present when `stdin: true` was requested. */
  readonly input?: ExecSessionInputController;
  /** Send a cancel signal and abort the underlying stream. */
  cancel(reason?: unknown): void;
}

export interface StartExecSessionOptions extends RequestOptions {
  readonly command: Command;
  readonly sandboxId: string;
  readonly stdin?: boolean;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly bufferedMaxKiB?: number;
}

export async function startExecSession(
  streamingClient: GatewayStreamingServiceClient,
  options: StartExecSessionOptions,
): Promise<ExecSession> {
  const abortController = linkedAbortController(options.signal);
  const call = streamingClient.streamExec(
    toRpcOptions({
      ...options,
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

  const stdinReady = options.stdin === true ? createStdinReadyGate() : undefined;
  const readyTimeoutMs = stdinReadyTimeoutMs(options.timeoutMs);

  const input: ExecSessionInputController | undefined =
    options.stdin === true
      ? {
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
              options.sandboxId,
            );
          },
          async write(data) {
            await withGrpcErrorMapping(
              "Write streaming stdin",
              async () => {
                await awaitStdinReadyOrAbort(stdinReady, readyTimeoutMs, abortController);
                await sendStreamingStdin(call.requests, data);
              },
              options.sandboxId,
            );
          },
        }
      : undefined;

  await withGrpcErrorMapping(
    "Start streaming command",
    async () => {
      await sendStreamingInit(call.requests, {
        ...options,
        command: [...options.command],
      });
      if (options.stdin !== true) {
        await completeRequests();
      }
    },
    options.sandboxId,
  );

  const frames = collectExecFrames(call, options, stdinReady, completeRequests);

  return {
    frames,
    ...(input !== undefined ? { input } : {}),
    cancel(reason?: unknown) {
      stdinReady?.signalFailed(
        reason ?? new CWSandboxTransportError("Session cancelled.", { operation: "Exec session" }),
      );
      abortController.abort(reason);
    },
  };
}

async function* collectExecFrames(
  call: DuplexStreamingCall<ProtoExecStreamRequest, ProtoExecStreamResponse>,
  options: StartExecSessionOptions,
  stdinReady: StdinReadyGate | undefined,
  onTerminal: () => Promise<void>,
): AsyncGenerator<ExecFrame, void, undefined> {
  let terminal = false;

  try {
    for await (const response of call.responses) {
      switch (response.response.oneofKind) {
        case "ready":
          stdinReady?.signalReady();
          yield { sessionId: response.response.ready.sessionId, type: "ready" };
          break;
        case "output":
          yield {
            data: response.response.output.data,
            type:
              response.response.output.streamType === ProtoExecStreamOutputStreamType.STDERR
                ? "stderr"
                : "stdout",
          };
          break;
        case "exit":
          terminal = true;
          stdinReady?.signalFailed(
            new CWSandboxTransportError("Streaming command exited before stdin was ready.", {
              operation: "Streaming command",
              sandboxId: options.sandboxId,
              transport: "grpc",
            }),
          );
          yield { exitCode: response.response.exit.exitCode, type: "exit" };
          await onTerminal().catch(() => undefined);
          return;
        case "error": {
          terminal = true;
          const error = mapExecSessionError(
            response.response.error.code,
            response.response.error.message || "Streaming command failed.",
            options.sandboxId,
          );
          stdinReady?.signalFailed(error);
          yield { error, type: "error" };
          await onTerminal().catch(() => undefined);
          return;
        }
        case undefined:
          break;
      }
    }

    await call.status;
    if (!terminal) {
      const error = new CWSandboxTransportError("Streaming command ended without an exit status.", {
        operation: "Streaming command",
        sandboxId: options.sandboxId,
        transport: "grpc",
      });
      stdinReady?.signalFailed(error);
      yield { error, type: "error" };
    }
  } catch (error) {
    const mapped = mapGrpcError(error, {
      operation: "Streaming command",
      sandboxId: options.sandboxId,
    });
    stdinReady?.signalFailed(mapped);
    yield { error: mapped, type: "error" };
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

/** Exported for unit tests. */
export function mapExecSessionError(
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
