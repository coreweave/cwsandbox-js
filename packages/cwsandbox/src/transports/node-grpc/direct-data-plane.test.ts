// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";
import { describe, expect, it, vi } from "vitest";

import { CWSandboxAuthenticationError, CWSandboxUnavailableError } from "../../errors.js";
import { DirectChannelPool, DirectDataPlane } from "./direct-data-plane.js";
import type { SandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";
import {
  SandboxDataPermission,
  SandboxDataProtocol,
  SandboxDataTransport,
  type ConnectSandboxRequest,
  type SandboxConnection,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import type { SandboxDataPlaneServiceClient } from "./generated/coreweave/sandbox/v1/sandbox_data_plane.client.js";
import { Timestamp } from "./generated/google/protobuf/timestamp.js";

const directClient = {} as SandboxDataPlaneServiceClient;
type ConnectSandbox = (request: ConnectSandboxRequest) => {
  readonly response: Promise<SandboxConnection>;
};

describe("DirectDataPlane", () => {
  it("does not request credentials in gateway mode", async () => {
    const connectSandbox = vi.fn<ConnectSandbox>();
    const direct = createDirect(connectSandbox);

    await expect(
      direct.acquire({
        dataPlaneMode: "gateway",
        permission: SandboxDataPermission.EXEC,
        sandboxId: "sandbox-a",
      }),
    ).resolves.toBeUndefined();
    expect(connectSandbox).not.toHaveBeenCalled();
  });

  it("issues permission-scoped credentials and returns a direct lease", async () => {
    const connectSandbox = vi.fn<ConnectSandbox>((request) => ({
      response: Promise.resolve(connection(request.requestedPermissions)),
    }));
    const direct = createDirect(connectSandbox);

    const lease = await direct.acquire({
      dataPlaneMode: "direct",
      permission: SandboxDataPermission.EXEC,
      sandboxId: "sandbox-a",
    });

    expect(lease?.client).toBe(directClient);
    expect(connectSandbox).toHaveBeenCalledTimes(1);
    const request = connectSandbox.mock.calls[0]?.[0];
    expect(request?.sandboxId).toBe("sandbox-a");
    expect(request?.csrDer.byteLength).toBeGreaterThan(0);
    expect(request?.requestedPermissions).toEqual([SandboxDataPermission.EXEC]);
    await lease?.release();
  });

  it("uses separate certificates for separate permissions", async () => {
    const connectSandbox = vi.fn<ConnectSandbox>((request) => ({
      response: Promise.resolve(connection(request.requestedPermissions)),
    }));
    const direct = createDirect(connectSandbox);

    const execLease = await direct.acquire({
      dataPlaneMode: "direct",
      permission: SandboxDataPermission.EXEC,
      sandboxId: "sandbox-a",
    });
    const readLease = await direct.acquire({
      dataPlaneMode: "direct",
      permission: SandboxDataPermission.READ_FILE,
      sandboxId: "sandbox-a",
    });

    expect(connectSandbox).toHaveBeenCalledTimes(2);
    expect(connectSandbox.mock.calls.map(([request]) => request.requestedPermissions)).toEqual([
      [SandboxDataPermission.EXEC],
      [SandboxDataPermission.READ_FILE],
    ]);
    await execLease?.release();
    await readLease?.release();
  });

  it("shares concurrent credential issuance", async () => {
    let resolveResponse: ((response: SandboxConnection) => void) | undefined;
    const response = new Promise<SandboxConnection>((resolve) => {
      resolveResponse = resolve;
    });
    const connectSandbox = vi.fn<ConnectSandbox>(() => ({ response }));
    const direct = createDirect(connectSandbox);

    const first = direct.acquire({
      dataPlaneMode: "direct",
      permission: SandboxDataPermission.EXEC,
      sandboxId: "sandbox-a",
    });
    const second = direct.acquire({
      dataPlaneMode: "direct",
      permission: SandboxDataPermission.EXEC,
      sandboxId: "sandbox-a",
    });
    await vi.waitFor(() => expect(connectSandbox).toHaveBeenCalledTimes(1));
    resolveResponse?.(connection([SandboxDataPermission.EXEC]));

    const leases = await Promise.all([first, second]);
    expect(connectSandbox).toHaveBeenCalledTimes(1);
    await Promise.all(leases.map((lease) => lease?.release()));
  });

  it("falls back in auto mode and cools down after an unavailable endpoint", async () => {
    const connectSandbox = vi.fn<ConnectSandbox>(() => ({
      response: Promise.reject(new RpcError("not enabled", "UNIMPLEMENTED")),
    }));
    const direct = createDirect(connectSandbox);
    const request = {
      dataPlaneMode: "auto" as const,
      permission: SandboxDataPermission.EXEC,
      sandboxId: "sandbox-a",
    };

    await expect(direct.acquire(request)).resolves.toBeUndefined();
    await expect(direct.acquire(request)).resolves.toBeUndefined();
    expect(connectSandbox).toHaveBeenCalledTimes(1);
  });

  it("does not hide authentication failures in auto mode", async () => {
    const connectSandbox = vi.fn<ConnectSandbox>(() => ({
      response: Promise.reject(new RpcError("not allowed", "PERMISSION_DENIED")),
    }));
    const direct = createDirect(connectSandbox);

    await expect(
      direct.acquire({
        dataPlaneMode: "auto",
        permission: SandboxDataPermission.EXEC,
        sandboxId: "sandbox-a",
      }),
    ).rejects.toBeInstanceOf(CWSandboxAuthenticationError);
  });

  it("surfaces direct-only connection failures", async () => {
    const connectSandbox = vi.fn<ConnectSandbox>(() => ({
      response: Promise.resolve({
        ...connection([SandboxDataPermission.EXEC]),
        endpointUri: "http://runner.example.test",
      }),
    }));
    const direct = createDirect(connectSandbox);

    await expect(
      direct.acquire({
        dataPlaneMode: "direct",
        permission: SandboxDataPermission.EXEC,
        sandboxId: "sandbox-a",
      }),
    ).rejects.toBeInstanceOf(CWSandboxUnavailableError);
  });
});

describe("DirectChannelPool", () => {
  it("bounds idle channels without evicting active streams", async () => {
    const closed: string[] = [];
    const pool = new DirectChannelPool(1, (bundle) => ({
      client: directClient,
      close: () => closed.push(bundle.cacheKey),
      ready: Promise.resolve(),
    }));
    const leaseA = await pool.acquire(bundle("a"), 100);
    const leaseB = await pool.acquire(bundle("b"), 100);
    await leaseB.release();
    const leaseC = await pool.acquire(bundle("c"), 100);
    await leaseC.release();

    expect(closed).toContain("b");
    expect(closed).not.toContain("a");

    await leaseA.release();
    expect(closed).toContain("c");
  });

  it("can discard a channel after its lease was released", async () => {
    const closed: string[] = [];
    const pool = new DirectChannelPool(64, (credential) => ({
      client: directClient,
      close: () => closed.push(credential.cacheKey),
      ready: Promise.resolve(),
    }));
    const lease = await pool.acquire(bundle("retiring"), 100);

    await lease.release();
    await lease.discard();

    expect(closed).toEqual(["retiring"]);
  });

  it("does not reuse a discarded channel while an old lease drains", async () => {
    const created: string[] = [];
    const closed: string[] = [];
    const pool = new DirectChannelPool(64, (credential) => {
      const generation = `${credential.cacheKey}-${created.length}`;
      created.push(generation);
      return {
        client: directClient,
        close: () => closed.push(generation),
        ready: Promise.resolve(),
      };
    });
    const stale = await pool.acquire(bundle("retiring"), 100);

    await stale.discard();
    const replacement = await pool.acquire(bundle("retiring"), 100);

    expect(created).toEqual(["retiring-0", "retiring-1"]);
    expect(closed).toEqual([]);
    await replacement.release();
    await stale.release();
    expect(closed).toEqual(["retiring-0"]);
  });
});

function createDirect(connectSandbox: ReturnType<typeof vi.fn<ConnectSandbox>>): DirectDataPlane {
  const controlClient = { connectSandbox } as unknown as SandboxServiceClient;
  const pool = new DirectChannelPool(64, () => ({
    client: directClient,
    close: () => undefined,
    ready: Promise.resolve(),
  }));
  return new DirectDataPlane(controlClient, pool);
}

function connection(grantedPermissions: SandboxDataPermission[]): SandboxConnection {
  return {
    clientCertificateChainPem: new TextEncoder().encode("certificate"),
    endpointId: "runner-a",
    endpointUri: "https://runner.example.test",
    expiresAt: Timestamp.create({ seconds: String(Math.floor(Date.now() / 1_000) + 3_600) }),
    grantedPermissions,
    protocol: SandboxDataProtocol.CONNECT_H2_V1,
    serverCaBundlePem: new Uint8Array(),
    transport: SandboxDataTransport.DIRECT_MTLS,
  };
}

function bundle(cacheKey: string) {
  return {
    cacheKey,
    certificateChain: Buffer.from("certificate"),
    expiresAtMs: Date.now() + 3_600_000,
    grantedPermissions: new Set([SandboxDataPermission.EXEC]),
    host: "runner.example.test",
    privateKey: Buffer.from("private-key"),
  };
}
