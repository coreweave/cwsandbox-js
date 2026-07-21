// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { RpcOptions } from "@protobuf-ts/runtime-rpc";

import { mapGrpcError } from "./errors.js";

export async function withGrpcErrorMapping<TResult>(
  operation: string,
  run: () => Promise<TResult>,
  sandboxId?: string,
): Promise<TResult> {
  try {
    return await run();
  } catch (error) {
    throw mapGrpcError(error, sandboxId === undefined ? { operation } : { operation, sandboxId });
  }
}

export function toRpcOptions(request: {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): RpcOptions {
  return {
    ...(request.signal ? { abort: request.signal } : {}),
    ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
  };
}

export function linkedAbortController(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();

  if (signal === undefined) {
    return controller;
  }

  if (signal.aborted) {
    controller.abort(signal.reason);
    return controller;
  }

  signal.addEventListener(
    "abort",
    () => {
      controller.abort(signal.reason);
    },
    { once: true },
  );

  return controller;
}
