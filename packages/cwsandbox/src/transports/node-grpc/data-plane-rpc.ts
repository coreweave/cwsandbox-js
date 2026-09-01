// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { RpcOptions } from "@protobuf-ts/runtime-rpc";

import type { DataPlaneMode } from "../../public/common.js";
import type { ISandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";
import type { SandboxDataPermission } from "./generated/coreweave/sandbox/v1/sandbox.js";

export type DataPlaneRpcClient = Pick<
  ISandboxServiceClient,
  "exec" | "readFile" | "streamExec" | "streamLogs" | "writeFile"
>;

export type DataPlanePermission =
  | typeof SandboxDataPermission.EXEC
  | typeof SandboxDataPermission.READ_FILE
  | typeof SandboxDataPermission.STREAM_EXEC
  | typeof SandboxDataPermission.STREAM_LOGS
  | typeof SandboxDataPermission.WRITE_FILE;

export interface PreparedDataPlaneCall {
  readonly client: DataPlaneRpcClient;
  readonly rpcOptions: RpcOptions;
  release(options?: { readonly discard?: boolean }): void;
  releaseWhenDone(done: Promise<unknown>): void;
}

export interface PrepareDataPlaneCallOptions {
  readonly dataPlaneMode?: DataPlaneMode;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type PrepareDataPlaneCall = (
  sandboxId: string,
  permission: DataPlanePermission,
  options?: PrepareDataPlaneCallOptions,
) => Promise<PreparedDataPlaneCall>;
