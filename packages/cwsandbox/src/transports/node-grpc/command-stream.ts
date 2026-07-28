// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { CommandProcess, CommandProcessWithStdin } from "../../public/commands.js";
import {
  createCommandProcess,
  type CommandInputController,
  type InternalCommandEvent,
} from "../../streaming/command-process.js";
import type { StartCommandRequest } from "../../transport/types.js";
import { startExecSession, mapExecSessionError, type ExecSession } from "./exec-session.js";
import type { GatewayStreamingServiceClient } from "./generated/coreweave/sandbox/v1beta2/streaming.client.js";

export { mapExecSessionError as mapExecStreamError };

export async function startGrpcCommand(
  streamingClient: GatewayStreamingServiceClient,
  request: StartCommandRequest,
): Promise<CommandProcess | CommandProcessWithStdin> {
  const session = await startExecSession(streamingClient, {
    command: request.command,
    sandboxId: request.sandboxId,
    stdin: request.stdin === true,
    ...(request.bufferedMaxKiB !== undefined ? { bufferedMaxKiB: request.bufferedMaxKiB } : {}),
    ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  });

  const sessionInput = session.input;
  const inputController: CommandInputController | undefined =
    sessionInput !== undefined
      ? {
          cancel: (reason) => sessionInput.cancel(reason),
          close: () => sessionInput.close(),
          write: (data) => sessionInput.write(data),
        }
      : undefined;

  let controller: ReturnType<typeof createCommandProcess>;
  if (request.stdin === true && inputController !== undefined) {
    controller = createCommandProcess(request.command, {
      ...(request.bufferedMaxKiB !== undefined ? { bufferedMaxKiB: request.bufferedMaxKiB } : {}),
      ...(request.check !== undefined ? { check: request.check } : {}),
      input: inputController,
      stdin: true,
    });
  } else {
    controller = createCommandProcess(request.command, {
      ...(request.bufferedMaxKiB !== undefined ? { bufferedMaxKiB: request.bufferedMaxKiB } : {}),
      ...(request.check !== undefined ? { check: request.check } : {}),
      ...(inputController !== undefined ? { input: inputController } : {}),
    });
  }

  void dispatchSessionFrames(session, controller.dispatch);

  return controller.process;
}

async function dispatchSessionFrames(
  session: ExecSession,
  dispatch: (event: InternalCommandEvent) => Promise<void>,
): Promise<void> {
  for await (const frame of session.frames) {
    switch (frame.type) {
      case "ready":
        await dispatch({ sessionId: frame.sessionId, type: "ready" });
        break;
      case "stdout":
        await dispatch({ data: frame.data, type: "stdout" });
        break;
      case "stderr":
        await dispatch({ data: frame.data, type: "stderr" });
        break;
      case "exit":
        await dispatch({ exitCode: frame.exitCode, type: "exit" });
        return;
      case "error":
        await dispatch({ error: frame.error, type: "error" });
        return;
    }
  }
}
