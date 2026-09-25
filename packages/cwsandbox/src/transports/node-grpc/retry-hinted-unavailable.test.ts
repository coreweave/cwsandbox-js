// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError, type RpcOptions } from "@protobuf-ts/runtime-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxClient } from "../../client.js";
import { CWSandboxNotFoundError, CWSandboxTransportError } from "../../errors.js";
import {
  CWSANDBOX_RUNNER_SHARD_RETIRING,
  CWSANDBOX_SANDBOX_NOT_FOUND,
} from "../../internal/error-info.js";
import type { DirectDataPlane } from "./direct-data-plane.js";
import { createGrpcFileAdapter } from "./file-adapter.js";
import type { SandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";
import { State } from "./generated/coreweave/sandbox/v1/sandbox.js";
import { GrpcSandboxTransport } from "./grpc-transport.js";
import { type HintedRetryOptions, retryHintedUnavailable } from "./retry-hinted-unavailable.js";
import { statusDetailsMeta } from "./test/status-details.js";

const RUNNER_UNAVAILABLE = "CWSANDBOX_RUNNER_UNAVAILABLE";

/** UNAVAILABLE + ErrorInfo reason + RetryInfo, the shape the Gateway returns. */
function hinted(
  delayMs = 1,
  options: { readonly code?: "UNAVAILABLE" | "INTERNAL"; readonly reason?: string } = {},
): RpcError {
  return new RpcError(
    "unavailable",
    options.code ?? "UNAVAILABLE",
    statusDetailsMeta({
      errorInfos: [{ reason: options.reason ?? RUNNER_UNAVAILABLE }],
      retryInfos: [
        { retrySeconds: Math.trunc(delayMs / 1_000), retryNanos: (delayMs % 1_000) * 1_000_000 },
      ],
    }),
  );
}

function notFound(): RpcError {
  return new RpcError(
    "gone",
    "NOT_FOUND",
    statusDetailsMeta({ errorInfos: [{ reason: CWSANDBOX_SANDBOX_NOT_FOUND }] }),
  );
}

/** Scripted attempt: rejects or resolves per outcome, recording each call's timeout. */
function scripted(...outcomes: unknown[]) {
  const timeouts: (number | undefined)[] = [];
  const attempt = async (timeoutMs: number | undefined): Promise<unknown> => {
    timeouts.push(timeoutMs);
    const outcome = outcomes.shift();
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  };
  return { attempt, timeouts };
}

/** Fake clock: sleep advances `now`. */
function fakeClock(start = 1_000) {
  const clock = { now: start };
  const sleeps: number[] = [];
  const options = {
    now: () => clock.now,
    random: () => 0,
    log: () => undefined,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.now += ms;
    },
  } satisfies Partial<HintedRetryOptions>;
  return { clock, options, sleeps };
}

function run(
  attempt: (timeoutMs: number | undefined) => Promise<unknown>,
  overrides: Partial<HintedRetryOptions> = {},
): Promise<unknown> {
  return retryHintedUnavailable(attempt, {
    ...fakeClock().options,
    operation: "op",
    ...overrides,
  });
}

describe("retryHintedUnavailable policy", () => {
  it("retries hinted UNAVAILABLE until success", async () => {
    const { attempt, timeouts } = scripted(hinted(), hinted(), "ok");
    await expect(run(attempt)).resolves.toBe("ok");
    expect(timeouts).toHaveLength(3);
  });

  it("does not retry bare UNAVAILABLE", async () => {
    const bare = new RpcError("down", "UNAVAILABLE");
    const { attempt, timeouts } = scripted(bare, "ok");
    await expect(run(attempt)).rejects.toBe(bare);
    expect(timeouts).toHaveLength(1);
  });

  it("does not retry an unavailable reason on another status", async () => {
    const internal = hinted(1, { code: "INTERNAL" });
    const { attempt, timeouts } = scripted(internal, "ok");
    await expect(run(attempt)).rejects.toBe(internal);
    expect(timeouts).toHaveLength(1);
  });

  it("does not retry an unavailable reason without RetryInfo", async () => {
    const noHint = new RpcError(
      "unavailable",
      "UNAVAILABLE",
      statusDetailsMeta({ errorInfos: [{ reason: RUNNER_UNAVAILABLE }] }),
    );
    const { attempt, timeouts } = scripted(noHint, "ok");
    await expect(run(attempt)).rejects.toBe(noHint);
    expect(timeouts).toHaveLength(1);
  });

  it("does not retry a negative delay", async () => {
    const negative = new RpcError(
      "unavailable",
      "UNAVAILABLE",
      statusDetailsMeta({ retryInfos: [{ retrySeconds: -1 }] }),
    );
    const { attempt, timeouts } = scripted(negative, "ok");
    await expect(run(attempt)).rejects.toBe(negative);
    expect(timeouts).toHaveLength(1);
  });

  it("retries a zero delay at once", async () => {
    const zero = new RpcError(
      "unavailable",
      "UNAVAILABLE",
      statusDetailsMeta({ retryInfos: [{ retrySeconds: 0 }] }),
    );
    const clock = fakeClock();
    const { attempt, timeouts } = scripted(zero, "ok");
    await expect(run(attempt, clock.options)).resolves.toBe("ok");
    expect(timeouts).toHaveLength(2);
    expect(clock.sleeps).toEqual([0]);
  });

  it("caps attempts and surfaces the last error", async () => {
    const errors = [hinted(), hinted(), hinted(), hinted()];
    const { attempt, timeouts } = scripted(...errors);
    await expect(run(attempt)).rejects.toBe(errors[2]);
    expect(timeouts).toHaveLength(3);
  });

  it("honours a smaller maxAttempts", async () => {
    const { attempt, timeouts } = scripted(hinted(), hinted(), "ok");
    await expect(run(attempt, { maxAttempts: 2 })).rejects.toBeInstanceOf(RpcError);
    expect(timeouts).toHaveLength(2);
  });

  it("raises a hint above 10 s without sleeping", async () => {
    const clock = fakeClock();
    const long = hinted(10_001);
    const { attempt, timeouts } = scripted(long, "ok");
    await expect(run(attempt, clock.options)).rejects.toBe(long);
    expect(timeouts).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("retries a hint of exactly 10 s", async () => {
    const clock = fakeClock();
    const { attempt, timeouts } = scripted(hinted(10_000), "ok");
    await expect(run(attempt, clock.options)).resolves.toBe("ok");
    expect(timeouts).toHaveLength(2);
    expect(clock.sleeps).toEqual([10_000]);
  });

  it("never sleeps below the hint and jitters up to 20% above it", async () => {
    const low = fakeClock();
    await run(scripted(hinted(5_000), "ok").attempt, { ...low.options, random: () => 0 });
    expect(low.sleeps).toEqual([5_000]);

    const high = fakeClock();
    await run(scripted(hinted(5_000), "ok").attempt, { ...high.options, random: () => 1 });
    expect(high.sleeps).toEqual([6_000]);
  });

  it("gives the first call the full timeout and later calls the remainder", async () => {
    const clock = fakeClock();
    const { attempt, timeouts } = scripted(hinted(5_000), "ok");
    await run(attempt, { ...clock.options, timeoutMs: 30_000 });
    expect(timeouts).toEqual([30_000, 25_000]);
  });

  it("keeps a zero first timeout unchanged", async () => {
    const { attempt, timeouts } = scripted("ok");
    await run(attempt, { timeoutMs: 0 });
    expect(timeouts).toEqual([0]);
  });

  it("imposes no deadline when timeoutMs is omitted", async () => {
    const { attempt, timeouts } = scripted(hinted(5_000), hinted(5_000), "ok");
    await expect(run(attempt)).resolves.toBe("ok");
    expect(timeouts).toEqual([undefined, undefined, undefined]);
  });

  it("does not retry when a 5 s backoff would leave under 5 s", async () => {
    const clock = fakeClock();
    const { attempt, timeouts } = scripted(hinted(5_000), "ok");
    await expect(run(attempt, { ...clock.options, timeoutMs: 9_999 })).rejects.toBeInstanceOf(
      RpcError,
    );
    expect(timeouts).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("retries when a 5 s backoff leaves exactly 5 s", async () => {
    const clock = fakeClock();
    const { attempt, timeouts } = scripted(hinted(5_000), "ok");
    await expect(run(attempt, { ...clock.options, timeoutMs: 10_000 })).resolves.toBe("ok");
    expect(timeouts).toEqual([10_000, 5_000]);
    expect(clock.sleeps).toEqual([5_000]);
  });

  it("stops when the backoff overslept past the floor", async () => {
    const clock = fakeClock();
    const oversleep = async (ms: number) => {
      clock.clock.now += ms + 16_000; // leaves 3 s, under the 5 s floor
    };
    const { attempt, timeouts } = scripted(hinted(1_000), "ok");
    await expect(
      run(attempt, { ...clock.options, sleep: oversleep, timeoutMs: 20_000 }),
    ).rejects.toBeInstanceOf(RpcError);
    expect(timeouts).toHaveLength(1);
  });

  it("turns an abort during backoff into CANCELLED without another call", async () => {
    const controller = new AbortController();
    const abortingSleep = async () => {
      controller.abort(new Error("caller gave up"));
      throw controller.signal.reason;
    };
    const { attempt, timeouts } = scripted(hinted(), "ok");
    const error = await run(attempt, { sleep: abortingSleep, signal: controller.signal }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("CANCELLED");
    expect(timeouts).toHaveLength(1);
  });

  it("checks the signal again after the backoff", async () => {
    const controller = new AbortController();
    const abortAfter = async () => {
      controller.abort(new Error("late"));
    };
    const { attempt, timeouts } = scripted(hinted(), "ok");
    const error = await run(attempt, { sleep: abortAfter, signal: controller.signal }).catch(
      (caught: unknown) => caught,
    );
    expect((error as RpcError).code).toBe("CANCELLED");
    expect(timeouts).toHaveLength(1);
  });

  it("logs one line per retry", async () => {
    const log = vi.fn<(message: string) => void>();
    await run(scripted(hinted(), hinted(), "ok").attempt, { log });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toContain(RUNNER_UNAVAILABLE);
    expect(log.mock.calls[0]?.[0]).toContain("attempt=2/3");
  });
});

// ---------------------------------------------------------------------------
// GrpcSandboxTransport: get / delete / stop
// ---------------------------------------------------------------------------

type Unary = (request: unknown, options?: RpcOptions) => { response: Promise<unknown> };

function transportWith(client: Record<string, Unary>) {
  const transport = new GrpcSandboxTransport({ apiKey: "test", baseUrl: "http://127.0.0.1:1" });
  Object.defineProperty(transport, "client", { value: client });
  const discard = vi.spyOn(transport.directDataPlane, "discardSandbox");
  return { discard, transport };
}

/** Unary stub replaying outcomes; records the RPC timeout of each call. */
function unary(...outcomes: unknown[]) {
  const timeouts: (number | undefined)[] = [];
  const fn = vi.fn<Unary>((_request, options) => {
    timeouts.push(options?.timeout as number | undefined);
    if (outcomes.length === 0) {
      throw new Error("unexpected extra call");
    }
    const outcome = outcomes.shift();
    return {
      response: outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
    };
  });
  return { fn, timeouts };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GrpcSandboxTransport hinted retry", () => {
  it("delete retries a hinted UNAVAILABLE", async () => {
    const del = unary(hinted(), {});
    const { discard, transport } = transportWith({ deleteSandbox: del.fn });
    await expect(transport.delete({ sandboxId: "sbx" })).resolves.toBeUndefined();
    expect(del.fn).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledWith("sbx");
  });

  it("delete surfaces the last error, mapped, after 3 calls", async () => {
    const last = hinted(1, { reason: "CWSANDBOX_SANDBOX_ROUTE_UNAVAILABLE" });
    const del = unary(hinted(), hinted(), last);
    const { transport } = transportWith({ deleteSandbox: del.fn });
    const error = await transport.delete({ sandboxId: "sbx" }).catch((caught: unknown) => caught);
    expect(del.fn).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect(error).toMatchObject({
      name: "CWSandboxUnavailableError",
      reason: "CWSANDBOX_SANDBOX_ROUTE_UNAVAILABLE",
      retryDelayMs: 1,
      transportCode: "UNAVAILABLE",
    });
    expect((error as Error).cause).toBe(last);
  });

  it("delete treats NOT_FOUND on a retry as deleted", async () => {
    const del = unary(hinted(), notFound());
    const { discard, transport } = transportWith({ deleteSandbox: del.fn });
    await expect(transport.delete({ sandboxId: "sbx" })).resolves.toBeUndefined();
    expect(del.fn).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledWith("sbx");
  });

  it("delete also accepts a trusted not-found reason on a retry", async () => {
    const reasonOnly = new RpcError(
      "gone",
      "FAILED_PRECONDITION",
      statusDetailsMeta({ errorInfos: [{ reason: CWSANDBOX_SANDBOX_NOT_FOUND }] }),
    );
    const del = unary(hinted(), reasonOnly);
    const { transport } = transportWith({ deleteSandbox: del.fn });
    await expect(transport.delete({ sandboxId: "sbx" })).resolves.toBeUndefined();
    expect(del.fn).toHaveBeenCalledTimes(2);
  });

  it("delete still raises NOT_FOUND on the first call", async () => {
    const del = unary(notFound());
    const { transport } = transportWith({ deleteSandbox: del.fn });
    await expect(transport.delete({ sandboxId: "sbx" })).rejects.toMatchObject({
      name: "CWSandboxNotFoundError",
    });
  });

  it("delete passes the remaining timeout to a retry", async () => {
    const del = unary(hinted(), {});
    const { transport } = transportWith({ deleteSandbox: del.fn });
    await transport.delete({ sandboxId: "sbx", timeoutMs: 60_000 });
    expect(del.timeouts[0]).toBe(60_000);
    expect(del.timeouts[1]).toBeLessThan(60_000);
    expect(del.timeouts[1]).toBeGreaterThan(55_000);
  });

  it("maps an abort during backoff to the CANCELLED transport error", async () => {
    const del = unary(hinted(200), {});
    const { transport } = transportWith({ deleteSandbox: del.fn });
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    setTimeout(() => controller.abort(reason), 10);
    const error = await transport
      .delete({ sandboxId: "sbx", signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(del.fn).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(CWSandboxTransportError);
    expect(error).toMatchObject({ transportCode: "CANCELLED" });
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(RpcError);
    expect((cause as Error).cause).toBe(reason);
  });

  it("stop retries and reports alreadyGone for NOT_FOUND on a retry", async () => {
    const del = unary(hinted(), notFound());
    const { discard, transport } = transportWith({ deleteSandbox: del.fn });
    await expect(transport.stop({ sandboxId: "sbx" })).resolves.toEqual({ alreadyGone: true });
    expect(del.fn).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledWith("sbx");
  });

  it("stop resolves undefined on ordinary success", async () => {
    const del = unary(hinted(), {});
    const { transport } = transportWith({ deleteSandbox: del.fn });
    await expect(transport.stop({ sandboxId: "sbx" })).resolves.toBeUndefined();
    expect(del.fn).toHaveBeenCalledTimes(2);
  });

  it("stop raises NOT_FOUND on the first call", async () => {
    const del = unary(notFound());
    const { transport } = transportWith({ deleteSandbox: del.fn });
    await expect(transport.stop({ sandboxId: "sbx" })).rejects.toMatchObject({
      name: "CWSandboxNotFoundError",
    });
  });

  it("get retries only when the internal marker is set", async () => {
    const plain = unary(hinted(), { sandboxId: "sbx" });
    await expect(
      transportWith({ getSandbox: plain.fn }).transport.get({ sandboxId: "sbx" }),
    ).rejects.toMatchObject({ name: "CWSandboxUnavailableError", operation: "Get sandbox" });
    expect(plain.fn).toHaveBeenCalledTimes(1);

    const marked = unary(hinted(), { sandboxId: "sbx" });
    await expect(
      transportWith({ getSandbox: marked.fn }).transport.get({
        retryHintedUnavailable: true,
        sandboxId: "sbx",
      }),
    ).resolves.toMatchObject({ sandboxId: "sbx" });
    expect(marked.fn).toHaveBeenCalledTimes(2);
  });

  it("get keeps NOT_FOUND after a retry as not-found", async () => {
    const get = unary(hinted(), notFound());
    const { transport } = transportWith({ getSandbox: get.fn });
    await expect(
      transport.get({ retryHintedUnavailable: true, sandboxId: "sbx" }),
    ).rejects.toMatchObject({ name: "CWSandboxNotFoundError" });
  });

  it("does not retry other unary calls", async () => {
    const list = unary(hinted(), { sandboxes: [] });
    const { transport } = transportWith({ listSandboxes: list.fn });
    await expect(transport.list({})).rejects.toMatchObject({ name: "CWSandboxUnavailableError" });
    expect(list.fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// File adapter: Gateway ReadFile only
// ---------------------------------------------------------------------------

function directLease(readError: Error) {
  return {
    client: {
      readFile: vi.fn<() => { response: Promise<never> }>(() => ({
        response: Promise.reject(readError),
      })),
      writeFile: () => ({ response: Promise.reject(readError) }),
    },
    discard: vi.fn<() => Promise<void>>(async () => undefined),
    release: vi.fn<(options?: { readonly discard?: boolean }) => Promise<void>>(
      async () => undefined,
    ),
  };
}

function retiring(): RpcError {
  return new RpcError(
    "retiring",
    "UNAVAILABLE",
    statusDetailsMeta({ errorInfos: [{ reason: CWSANDBOX_RUNNER_SHARD_RETIRING }] }),
  );
}

describe("file adapter hinted retry", () => {
  it("retries a Gateway ReadFile", async () => {
    const read = unary(hinted(), { content: new Uint8Array([7]) });
    const adapter = createGrpcFileAdapter({
      client: { readFile: read.fn } as unknown as SandboxServiceClient,
    });
    await expect(adapter.read({ path: "/f", sandboxId: "sbx" })).resolves.toEqual({
      content: new Uint8Array([7]),
    });
    expect(read.fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a Gateway WriteFile", async () => {
    const write = unary(hinted(), {});
    const adapter = createGrpcFileAdapter({
      client: { writeFile: write.fn } as unknown as SandboxServiceClient,
    });
    await expect(
      adapter.write({ content: new Uint8Array([1]), path: "/f", sandboxId: "sbx" }),
    ).rejects.toMatchObject({ name: "CWSandboxUnavailableError" });
    expect(write.fn).toHaveBeenCalledTimes(1);
  });

  it("does not add a hinted retry to a direct ReadFile", async () => {
    const lease = directLease(hinted());
    const acquire = vi.fn<(options: unknown) => Promise<unknown>>().mockResolvedValue(lease);
    const read = unary({ content: new Uint8Array([1]) });
    const adapter = createGrpcFileAdapter(
      { client: { readFile: read.fn } as unknown as SandboxServiceClient },
      { acquire } as unknown as DirectDataPlane,
    );
    await expect(
      adapter.read({ dataPlaneMode: "direct", path: "/f", sandboxId: "sbx" }),
    ).rejects.toMatchObject({ name: "CWSandboxUnavailableError" });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(lease.client.readFile).toHaveBeenCalledTimes(1);
    expect(read.fn).not.toHaveBeenCalled();
  });

  it("shares the 3-call cap with a direct shard-retirement pass", async () => {
    const lease = directLease(retiring());
    const acquire = vi
      .fn<(options: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce(lease)
      .mockResolvedValueOnce(undefined);
    const read = unary(hinted(), hinted(), hinted());
    const adapter = createGrpcFileAdapter(
      { client: { readFile: read.fn } as unknown as SandboxServiceClient },
      { acquire } as unknown as DirectDataPlane,
    );
    await expect(adapter.read({ path: "/f", sandboxId: "sbx" })).rejects.toMatchObject({
      name: "CWSandboxUnavailableError",
    });
    expect(read.fn).toHaveBeenCalledTimes(2);
  });

  it("gives the Gateway fallback the full timeout even after a slow direct pass", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const lease = directLease(retiring());
    lease.client.readFile.mockImplementation(() => {
      clock += 20_000;
      return { response: Promise.reject(retiring()) };
    });
    const acquire = vi
      .fn<(options: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce(lease)
      .mockResolvedValueOnce(undefined);
    const read = unary({ content: new Uint8Array([1]) });
    const adapter = createGrpcFileAdapter(
      { client: { readFile: read.fn } as unknown as SandboxServiceClient },
      { acquire } as unknown as DirectDataPlane,
    );
    await adapter.read({ path: "/f", sandboxId: "sbx", timeoutMs: 30_000 });
    expect(read.timeouts).toEqual([30_000]);
  });
});

describe("stop() through the gRPC transport", () => {
  it("does not count a retried status check toward the stop RPC's retry", async () => {
    const hinted = new RpcError(
      "unavailable",
      "UNAVAILABLE",
      statusDetailsMeta({
        errorInfos: [{ reason: "CWSANDBOX_RUNNER_UNAVAILABLE" }],
        retryInfos: [{ retrySeconds: 0, retryNanos: 1_000_000 }],
      }),
    );
    const running = { sandboxId: "sbx", status: { state: State.RUNNING } };
    const gets: unknown[] = [running, hinted, running];
    const deletes: unknown[] = [new RpcError("gone", "NOT_FOUND")];
    const next = (queue: unknown[]) => {
      const outcome = queue.shift();
      return {
        response: outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
      };
    };
    const transport = new GrpcSandboxTransport({ apiKey: "test", baseUrl: "http://127.0.0.1:1" });
    Object.defineProperty(transport, "client", {
      value: { deleteSandbox: () => next(deletes), getSandbox: () => next(gets) },
    });
    const client = new SandboxClient({ fileAdapter: {} as never, transport });
    const sandbox = await client.fromId("sbx");

    await expect(sandbox.stop()).rejects.toBeInstanceOf(CWSandboxNotFoundError);
    expect(gets).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });
});
