// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as channel from "./channel.js";
import type { MtlsDataPlaneSession } from "./channel.js";
import type { DataPlaneRpcClient } from "./data-plane-rpc.js";
import {
  credentialBundle,
  createDirectPreparedCall,
  createGatewayPreparedCall,
  DirectChannelPool,
  DirectDataPlaneClient,
  DirectDataPlaneUnavailable,
  DIRECT_RETRY_COOLDOWN_MS,
  isDirectStrict,
  isGatewayOnly,
  MAX_IDLE_DIRECT_CHANNELS,
  resetDirectChannelPoolForTests,
  type ConnectSandboxCall,
} from "./direct.js";
import {
  SandboxDataPermission,
  SandboxDataProtocol,
  SandboxDataTransport,
  type SandboxConnection,
} from "./generated/coreweave/sandbox/v1/sandbox.js";

describe("direct data-plane", () => {
  beforeEach(() => {
    resetDirectChannelPoolForTests();
    vi.spyOn(channel, "createMtlsDataPlaneSession").mockImplementation(() => fakeSession());
  });

  afterEach(() => {
    resetDirectChannelPoolForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("credentialBundle", () => {
    it("accepts DIRECT_MTLS over HTTPS with CONNECT_H2_V1", () => {
      const bundle = credentialBundle(Buffer.from("key"), "sbx", connection());
      expect(bundle.endpointUri).toBe("https://runner.example.com");
      expect(bundle.grantedPermissions.has(SandboxDataPermission.EXEC)).toBe(true);
    });

    it("rejects an unsupported transport, protocol, or HTTP endpoint", () => {
      expect(() =>
        credentialBundle(
          Buffer.from("key"),
          "sbx",
          connection({ transport: SandboxDataTransport.UNSPECIFIED }),
        ),
      ).toThrow(DirectDataPlaneUnavailable);
      expect(() =>
        credentialBundle(
          Buffer.from("key"),
          "sbx",
          connection({ protocol: SandboxDataProtocol.UNSPECIFIED }),
        ),
      ).toThrow(DirectDataPlaneUnavailable);
      expect(() =>
        credentialBundle(
          Buffer.from("key"),
          "sbx",
          connection({ endpointUri: "http://runner.example.com" }),
        ),
      ).toThrow(/must use HTTPS/);
    });

    it("rejects a missing certificate or an already-expiring cert", () => {
      expect(() =>
        credentialBundle(
          Buffer.from("key"),
          "sbx",
          connection({ clientCertificateChainPem: new Uint8Array() }),
        ),
      ).toThrow(/no client certificate/);
      expect(() =>
        credentialBundle(
          Buffer.from("key"),
          "sbx",
          connection({
            expiresAt: { nanos: 0, seconds: String(Math.floor(Date.now() / 1000) + 10) },
          }),
        ),
      ).toThrow(/already expiring/);
    });
  });

  describe("DirectChannelPool", () => {
    it("caps idle channels at 64 and never evicts an active lease", async () => {
      const pool = new DirectChannelPool();
      for (let index = 0; index < MAX_IDLE_DIRECT_CHANNELS + 1; index += 1) {
        const lease = await pool.acquire(testBundle(index), 1_000);
        lease.release();
      }
      expect(pool.size()).toBe(MAX_IDLE_DIRECT_CHANNELS);
      expect(pool.idleCount()).toBe(MAX_IDLE_DIRECT_CHANNELS);

      const small = new DirectChannelPool(1);
      const first = await small.acquire(testBundle(1), 1_000);
      const second = await small.acquire(testBundle(2), 1_000);
      const third = await small.acquire(testBundle(3), 1_000);
      expect(small.size()).toBe(3);
      expect(small.idleCount()).toBe(0);
      first.release();
      second.release();
      expect(small.size()).toBe(2);
      expect(small.idleCount()).toBe(1);
      third.release();
      expect(small.size()).toBe(1);
      expect(small.idleCount()).toBe(1);
    });

    it("shares the first waitForReady promise for a cache key", async () => {
      let resolveReady: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const waitForReady = vi.fn<(timeoutMs: number) => Promise<void>>(() => ready);
      vi.mocked(channel.createMtlsDataPlaneSession).mockReturnValue(fakeSession({ waitForReady }));
      const pool = new DirectChannelPool();
      const first = pool.acquire(testBundle(1), 100);
      const second = pool.acquire(testBundle(1), 5_000);

      expect(channel.createMtlsDataPlaneSession).toHaveBeenCalledTimes(1);
      expect(waitForReady).toHaveBeenCalledTimes(1);
      expect(waitForReady).toHaveBeenCalledWith(100);

      resolveReady();
      const [left, right] = await Promise.all([first, second]);
      expect(pool.size()).toBe(1);
      left.release();
      right.release();
    });

    it("discards a channel when shared readiness fails", async () => {
      vi.mocked(channel.createMtlsDataPlaneSession).mockReturnValue(
        fakeSession({
          waitForReady: vi.fn<(timeoutMs: number) => Promise<void>>(async () => {
            throw new Error("not ready");
          }),
        }),
      );
      const pool = new DirectChannelPool();
      await expect(pool.acquire(testBundle(1), 100)).rejects.toThrow("not ready");
      expect(pool.size()).toBe(0);
    });
  });

  describe("DirectDataPlaneClient", () => {
    it("defers AUTO retries for 30s after a soft ConnectSandbox failure", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
      const connect = vi.fn<ConnectSandboxCall>(async () => {
        throw new RpcError("unavailable", "UNAVAILABLE");
      });
      const client = new DirectDataPlaneClient(connect, new DirectChannelPool());

      await expect(
        client.acquire({
          permission: SandboxDataPermission.EXEC,
          requestTimeoutMs: 30_000,
          sandboxId: "sbx",
          strict: false,
        }),
      ).rejects.toBeInstanceOf(DirectDataPlaneUnavailable);
      expect(connect).toHaveBeenCalledTimes(1);

      await expect(
        client.acquire({
          permission: SandboxDataPermission.EXEC,
          requestTimeoutMs: 30_000,
          sandboxId: "sbx",
          strict: false,
        }),
      ).rejects.toBeInstanceOf(DirectDataPlaneUnavailable);
      expect(connect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(DIRECT_RETRY_COOLDOWN_MS);
      await expect(
        client.acquire({
          permission: SandboxDataPermission.EXEC,
          requestTimeoutMs: 30_000,
          sandboxId: "sbx",
          strict: false,
        }),
      ).rejects.toBeInstanceOf(DirectDataPlaneUnavailable);
      expect(connect).toHaveBeenCalledTimes(2);
    });

    it("does not fall back after a DIRECT ConnectSandbox failure", async () => {
      const connect = vi.fn<ConnectSandboxCall>(async () => {
        throw new RpcError("precondition", "FAILED_PRECONDITION");
      });
      const client = new DirectDataPlaneClient(connect, new DirectChannelPool());

      await expect(
        client.acquire({
          permission: SandboxDataPermission.EXEC,
          requestTimeoutMs: 30_000,
          sandboxId: "sbx",
          strict: true,
        }),
      ).rejects.toBeInstanceOf(DirectDataPlaneUnavailable);
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("retries DIRECT only on UNAVAILABLE within the connect budget", async () => {
      vi.useFakeTimers();
      const connect = vi
        .fn<ConnectSandboxCall>()
        .mockRejectedValueOnce(new RpcError("unavailable", "UNAVAILABLE"))
        .mockResolvedValueOnce(connection());
      const client = new DirectDataPlaneClient(connect, new DirectChannelPool());
      const pending = client.acquire({
        permission: SandboxDataPermission.EXEC,
        requestTimeoutMs: 30_000,
        sandboxId: "sbx",
        strict: true,
      });

      await vi.advanceTimersByTimeAsync(200);
      const lease = await pending;
      expect(connect).toHaveBeenCalledTimes(2);
      lease.release();
    });

    it("releases a lease back to the idle pool", async () => {
      const connect = vi.fn<ConnectSandboxCall>(async () => connection());
      const pool = new DirectChannelPool();
      const client = new DirectDataPlaneClient(connect, pool);
      const lease = await client.acquire({
        permission: SandboxDataPermission.EXEC,
        requestTimeoutMs: 30_000,
        sandboxId: "sbx",
        strict: true,
      });

      expect(pool.size()).toBe(1);
      expect(pool.idleCount()).toBe(0);
      lease.release();
      expect(pool.idleCount()).toBe(1);
      expect(pool.size()).toBe(1);
    });
  });

  describe("prepared calls", () => {
    it("sends empty metadata on direct RPCs", () => {
      const release = vi.fn<(options?: { readonly discard?: boolean }) => void>();
      const prepared = createDirectPreparedCall({
        client: {} as DataPlaneRpcClient,
        release,
      });

      expect(prepared.rpcOptions.meta).toEqual({});
      prepared.release();
      expect(release).toHaveBeenCalledTimes(1);
      prepared.release();
      expect(release).toHaveBeenCalledTimes(1);
    });

    it("does not attach call metadata on the gateway helper", () => {
      const prepared = createGatewayPreparedCall({} as DataPlaneRpcClient);
      expect(prepared.rpcOptions.meta).toBeUndefined();
    });
  });

  it("classifies auto/direct/gateway mode helpers", () => {
    expect(isDirectStrict(undefined)).toBe(false);
    expect(isDirectStrict("auto")).toBe(false);
    expect(isDirectStrict("direct")).toBe(true);
    expect(isGatewayOnly(undefined)).toBe(false);
    expect(isGatewayOnly("auto")).toBe(false);
    expect(isGatewayOnly("gateway")).toBe(true);
  });
});

function connection(overrides: Partial<SandboxConnection> = {}): SandboxConnection {
  return {
    clientCertificateChainPem: new Uint8Array([1, 2, 3]),
    endpointId: "ep-1",
    endpointUri: "https://runner.example.com",
    expiresAt: { nanos: 0, seconds: String(Math.floor(Date.now() / 1000) + 3_600) },
    grantedPermissions: [SandboxDataPermission.EXEC],
    protocol: SandboxDataProtocol.CONNECT_H2_V1,
    serverCaBundlePem: new Uint8Array(),
    transport: SandboxDataTransport.DIRECT_MTLS,
    ...overrides,
  };
}

function testBundle(index: number) {
  return {
    cacheKey: `ep:sbx:${index}`,
    certificateChainPem: new Uint8Array([index]),
    endpointUri: "https://runner.example.com",
    expiresAt: new Date(Date.now() + 60_000),
    grantedPermissions: new Set([SandboxDataPermission.EXEC]),
    privateKeyPem: Buffer.from("key"),
    serverCaBundlePem: new Uint8Array(),
  };
}

function fakeSession(overrides: Partial<MtlsDataPlaneSession> = {}): MtlsDataPlaneSession {
  return {
    client: {} as DataPlaneRpcClient,
    close: vi.fn<() => void>(),
    waitForReady: vi.fn<(timeoutMs: number) => Promise<void>>(async () => undefined),
    ...overrides,
  };
}
