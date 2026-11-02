// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError, type RpcOptions } from "@protobuf-ts/runtime-rpc";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CWSandboxTimeoutError, CWSandboxUnavailableError } from "../../errors.js";
import { CWSANDBOX_RUNNER_SHARD_RETIRING } from "../../internal/error-info.js";
import type { DirectDataPlaneLease } from "./direct-data-plane.js";
import { ExecResponse } from "./generated/coreweave/sandbox/v1/sandbox.js";
import { GrpcSandboxTransport } from "./grpc-transport.js";
import { statusDetailsMeta } from "./test/status-details.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function retiring(): RpcError {
  return new RpcError(
    "retiring",
    "UNAVAILABLE",
    statusDetailsMeta({ errorInfos: [{ reason: CWSANDBOX_RUNNER_SHARD_RETIRING }] }),
  );
}

type Exec = (timeoutMs: number | undefined) => { readonly ms: number; readonly error?: Error };

/**
 * A transport on a fake clock whose direct leases run `execs` in order. Each
 * exec gets the RPC timeout and returns how long it takes and its outcome. A
 * `{ leaseError }` entry makes that lease wait use its whole timeout and fail.
 */
function retiringTransport(
  leaseWaitMs: number,
  ...execs: (Exec | { readonly leaseError: Error })[]
) {
  let clock = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const transport = new GrpcSandboxTransport({ apiKey: "test", baseUrl: "http://127.0.0.1:1" });
  const acquireTimeouts: (number | undefined)[] = [];
  const execTimeouts: (number | undefined)[] = [];
  let execStart: number | undefined;
  const acquire = vi
    .spyOn(transport.directDataPlane, "acquire")
    .mockImplementation(async (options) => {
      acquireTimeouts.push(options.timeoutMs);
      clock += leaseWaitMs;
      const run = execs.shift();
      if (run === undefined) {
        throw new Error("unexpected extra lease");
      }
      if (typeof run !== "function") {
        clock += options.timeoutMs ?? 0;
        throw run.leaseError;
      }
      const exec = (_request: unknown, rpcOptions: RpcOptions) => {
        const timeoutMs = rpcOptions.timeout as number | undefined;
        execTimeouts.push(timeoutMs);
        execStart ??= clock;
        const outcome = run(timeoutMs);
        clock += outcome.ms;
        return {
          response:
            outcome.error === undefined
              ? Promise.resolve(ExecResponse.create({ exitCode: 0 }))
              : Promise.reject(outcome.error),
        };
      };
      return {
        client: { exec },
        discard: async () => undefined,
        release: async () => undefined,
      } as unknown as DirectDataPlaneLease;
    });
  return {
    acquire,
    acquireTimeouts,
    elapsedSinceFirstExec: () => clock - (execStart ?? clock),
    execTimeouts,
    transport,
  };
}

describe("exec retry on a retiring runner shard", () => {
  it("gives the retry only the remaining timeout", async () => {
    const t = retiringTransport(
      1_000,
      () => ({ error: retiring(), ms: 4_000 }),
      // Worst case: the retried call runs until its deadline.
      (timeoutMs) => ({ ms: timeoutMs ?? 0 }),
    );

    await expect(
      t.transport.exec({ command: ["true"], sandboxId: "sbx", timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(t.acquireTimeouts).toEqual([10_000, 6_000]);
    expect(t.execTimeouts).toEqual([10_000, 5_000]);
    expect(t.elapsedSinceFirstExec()).toBeLessThanOrEqual(10_000);
  });

  it("does not retry once the timeout is spent", async () => {
    const t = retiringTransport(0, () => ({ error: retiring(), ms: 10_000 }));

    const error = await t.transport
      .exec({ command: ["true"], sandboxId: "sbx", timeoutMs: 10_000 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CWSandboxTimeoutError);
    expect(error).toMatchObject({
      cause: { reason: CWSANDBOX_RUNNER_SHARD_RETIRING },
      operation: "Exec command",
      sandboxId: "sbx",
    });
    expect(t.acquire).toHaveBeenCalledTimes(1);
  });

  it("throws a timeout when the retry's lease wait uses up the remaining time", async () => {
    const leaseError = new CWSandboxUnavailableError("Direct data-plane access is unavailable.");
    const t = retiringTransport(0, () => ({ error: retiring(), ms: 9_600 }), { leaseError });

    const error = await t.transport
      .exec({ command: ["true"], sandboxId: "sbx", timeoutMs: 10_000 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CWSandboxTimeoutError);
    expect(error).toMatchObject({ cause: leaseError, operation: "Exec command", sandboxId: "sbx" });
    expect(t.acquireTimeouts).toEqual([10_000, 400]);
  });

  it("gives the retry a near-zero timeout when almost nothing is left", async () => {
    const t = retiringTransport(
      1,
      () => ({ error: retiring(), ms: 9_998 }),
      (timeoutMs) => ({
        error: new RpcError("deadline", "DEADLINE_EXCEEDED"),
        ms: timeoutMs ?? 0,
      }),
    );

    await expect(
      t.transport.exec({ command: ["true"], sandboxId: "sbx", timeoutMs: 10_000 }),
    ).rejects.toBeInstanceOf(CWSandboxTimeoutError);

    expect(t.acquireTimeouts).toEqual([10_000, 2]);
    expect(t.execTimeouts).toEqual([10_000, 1]);
    expect(t.elapsedSinceFirstExec()).toBeLessThanOrEqual(10_000);
  });

  it("rethrows a non-retiring error after the deadline unchanged", async () => {
    const t = retiringTransport(0, () => ({
      error: new RpcError("down", "UNAVAILABLE"),
      ms: 10_001,
    }));

    const error = await t.transport
      .exec({ command: ["true"], sandboxId: "sbx", timeoutMs: 10_000 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CWSandboxUnavailableError);
    expect(error).not.toBeInstanceOf(CWSandboxTimeoutError);
    expect(t.acquire).toHaveBeenCalledTimes(1);
  });

  it("retries without a deadline when no timeout is set", async () => {
    const t = retiringTransport(
      0,
      () => ({ error: retiring(), ms: 60_000 }),
      () => ({ ms: 0 }),
    );

    await expect(t.transport.exec({ command: ["true"], sandboxId: "sbx" })).resolves.toMatchObject({
      exitCode: 0,
    });

    expect(t.acquireTimeouts).toEqual([undefined, undefined]);
    expect(t.execTimeouts).toEqual([undefined, undefined]);
  });
});
