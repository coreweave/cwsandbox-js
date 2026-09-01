// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { createHash } from "node:crypto";

import { RpcError } from "@protobuf-ts/runtime-rpc";

import { DEFAULT_DATA_PLANE_MODE } from "../../internal/data-plane.js";
import type { DataPlaneMode } from "../../public/common.js";
import {
  createMtlsDataPlaneSession,
  parseGrpcTarget,
  type MtlsDataPlaneSession,
} from "./channel.js";
import { generateP256Csr } from "./csr.js";
import type {
  DataPlanePermission,
  DataPlaneRpcClient,
  PrepareDataPlaneCallOptions,
  PreparedDataPlaneCall,
} from "./data-plane-rpc.js";
import type { SandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";
import {
  ConnectSandboxRequest,
  SandboxDataProtocol,
  SandboxDataTransport,
  type SandboxConnection,
  type SandboxDataPermission,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import { toRpcOptions } from "./rpc.js";

export const DIRECT_AUTO_TIMEOUT_MS = 1_000;
export const DIRECT_CONNECT_TIMEOUT_MS = 10_000;
export const DIRECT_CREDENTIAL_RPC_TIMEOUT_MS = 5_000;
export const DIRECT_RETRY_COOLDOWN_MS = 30_000;
export const DIRECT_EXPIRY_SKEW_MS = 30_000;
export const MAX_IDLE_DIRECT_CHANNELS = 64;
export const DEFAULT_DATA_PLANE_REQUEST_TIMEOUT_MS = 300_000;

const FALLBACK_CONNECT_CODES = new Set([
  "DEADLINE_EXCEEDED",
  "FAILED_PRECONDITION",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "UNIMPLEMENTED",
]);

const DIRECT_READINESS_RETRY_CODES = new Set(["UNAVAILABLE"]);

export class DirectDataPlaneUnavailable extends Error {
  public override readonly name = "DirectDataPlaneUnavailable";
}

export class DirectDataPlanePermissionUnavailable extends Error {
  public override readonly name = "DirectDataPlanePermissionUnavailable";
}

export interface CredentialBundle {
  readonly cacheKey: string;
  readonly certificateChainPem: Uint8Array;
  readonly endpointUri: string;
  readonly expiresAt: Date;
  readonly grantedPermissions: ReadonlySet<SandboxDataPermission>;
  readonly privateKeyPem: Buffer;
  readonly serverCaBundlePem: Uint8Array;
}

export interface ConnectSandboxCall {
  (input: ConnectSandboxRequest, timeoutMs: number): Promise<SandboxConnection>;
}

interface PoolEntry {
  activeLeases: number;
  discardWhenIdle: boolean;
  readonly session: MtlsDataPlaneSession;
  readiness: Promise<void>;
}

export interface DirectChannelLease {
  readonly client: DataPlaneRpcClient;
  release(options?: { readonly discard?: boolean }): void;
}

export class DirectChannelPool {
  public constructor(private readonly maxIdleChannels = MAX_IDLE_DIRECT_CHANNELS) {}

  private readonly entries = new Map<string, PoolEntry>();
  private readonly insertionOrder: string[] = [];

  public acquire(bundle: CredentialBundle, timeoutMs: number): Promise<DirectChannelLease> {
    let entry = this.entries.get(bundle.cacheKey);
    if (entry === undefined) {
      const session = createMtlsDataPlaneSession({
        certificateChainPem: bundle.certificateChainPem,
        endpointUri: bundle.endpointUri,
        privateKeyPem: bundle.privateKeyPem,
        serverCaBundlePem: bundle.serverCaBundlePem,
      });
      entry = {
        activeLeases: 0,
        discardWhenIdle: false,
        readiness: session.waitForReady(timeoutMs).catch((error: unknown) => {
          throw error;
        }),
        session,
      };
      this.entries.set(bundle.cacheKey, entry);
      this.insertionOrder.push(bundle.cacheKey);
    }
    entry.activeLeases += 1;
    this.touch(bundle.cacheKey);

    const lease: DirectChannelLease = {
      client: entry.session.client,
      release: (options) => {
        this.release(bundle.cacheKey, options?.discard === true);
      },
    };

    return entry.readiness.then(
      () => lease,
      (error: unknown) => {
        lease.release({ discard: true });
        throw error;
      },
    );
  }

  public release(cacheKey: string, discard = false): void {
    const entry = this.entries.get(cacheKey);
    if (entry === undefined) {
      return;
    }
    entry.activeLeases = Math.max(0, entry.activeLeases - 1);
    entry.discardWhenIdle = entry.discardWhenIdle || discard;
    this.touch(cacheKey);
    if (entry.activeLeases === 0 && entry.discardWhenIdle) {
      this.remove(cacheKey);
    }
    this.evictIdle();
  }

  public discard(cacheKey: string): void {
    const entry = this.entries.get(cacheKey);
    if (entry === undefined) {
      return;
    }
    if (entry.activeLeases > 0) {
      entry.discardWhenIdle = true;
      return;
    }
    this.remove(cacheKey);
  }

  public idleCount(): number {
    return [...this.entries.values()].filter((entry) => entry.activeLeases === 0).length;
  }

  public size(): number {
    return this.entries.size;
  }

  public reset(): void {
    for (const key of [...this.entries.keys()]) {
      this.remove(key);
    }
  }

  private evictIdle(): void {
    let idle = this.idleCount();
    if (idle <= this.maxIdleChannels) {
      return;
    }
    for (const cacheKey of [...this.insertionOrder]) {
      if (idle <= this.maxIdleChannels) {
        break;
      }
      const entry = this.entries.get(cacheKey);
      if (entry === undefined || entry.activeLeases > 0) {
        continue;
      }
      this.remove(cacheKey);
      idle -= 1;
    }
  }

  private touch(cacheKey: string): void {
    const index = this.insertionOrder.indexOf(cacheKey);
    if (index >= 0) {
      this.insertionOrder.splice(index, 1);
    }
    this.insertionOrder.push(cacheKey);
  }

  private remove(cacheKey: string): void {
    const entry = this.entries.get(cacheKey);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(cacheKey);
    const index = this.insertionOrder.indexOf(cacheKey);
    if (index >= 0) {
      this.insertionOrder.splice(index, 1);
    }
    entry.session.close();
  }
}

const sharedPool = new DirectChannelPool();

export function resetDirectChannelPoolForTests(): void {
  sharedPool.reset();
}

export class DirectDataPlaneClient {
  private readonly credentials = new Map<SandboxDataPermission, CredentialBundle>();
  private lock: Promise<void> = Promise.resolve();
  private retryAt = 0;

  public constructor(
    private readonly connectSandbox: ConnectSandboxCall,
    private readonly pool: DirectChannelPool = sharedPool,
  ) {}

  public async acquire(options: {
    readonly permission: DataPlanePermission;
    readonly requestTimeoutMs: number;
    readonly sandboxId: string;
    readonly strict: boolean;
  }): Promise<DirectChannelLease> {
    const autoDeadline =
      options.strict === true
        ? undefined
        : Date.now() + Math.min(options.requestTimeoutMs, DIRECT_AUTO_TIMEOUT_MS);
    const bundle = await this.ensureCredentials({
      deadline: autoDeadline,
      permission: options.permission,
      requestTimeoutMs: options.requestTimeoutMs,
      sandboxId: options.sandboxId,
      strict: options.strict,
    });
    if (!bundle.grantedPermissions.has(options.permission)) {
      throw new DirectDataPlanePermissionUnavailable(
        `The direct data-plane certificate does not grant permission ${options.permission}`,
      );
    }

    let connectTimeoutMs = Math.min(options.requestTimeoutMs, DIRECT_CONNECT_TIMEOUT_MS);
    if (autoDeadline !== undefined) {
      connectTimeoutMs = Math.max(0, autoDeadline - Date.now());
    }
    if (connectTimeoutMs <= 0) {
      this.deferRetry();
      throw new DirectDataPlaneUnavailable(
        `Timed out connecting to the direct data-plane endpoint ${bundle.endpointUri}`,
      );
    }

    try {
      const lease = await this.pool.acquire(bundle, connectTimeoutMs);
      this.retryAt = 0;
      return lease;
    } catch (error) {
      this.deferRetry();
      throw new DirectDataPlaneUnavailable(
        `Could not connect to the direct data-plane endpoint ${bundle.endpointUri}`,
        { cause: error },
      );
    }
  }

  public close(): void {
    const keys = [...this.credentials.values()].map((bundle) => bundle.cacheKey);
    this.credentials.clear();
    this.retryAt = 0;
    for (const cacheKey of keys) {
      this.pool.discard(cacheKey);
    }
  }

  private async ensureCredentials(options: {
    readonly deadline: number | undefined;
    readonly permission: DataPlanePermission;
    readonly requestTimeoutMs: number;
    readonly sandboxId: string;
    readonly strict: boolean;
  }): Promise<CredentialBundle> {
    if (!options.strict && Date.now() < this.retryAt) {
      throw new DirectDataPlaneUnavailable("Direct data-plane retry is temporarily deferred");
    }
    const cached = this.credentials.get(options.permission);
    if (cached !== undefined && cached.expiresAt.getTime() > Date.now() + DIRECT_EXPIRY_SKEW_MS) {
      return cached;
    }
    return this.withLock(() => this.requestCredentials(options));
  }

  private async withLock<TResult>(run: () => Promise<TResult>): Promise<TResult> {
    const previous = this.lock;
    let release = (): void => undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  private async requestCredentials(options: {
    readonly deadline: number | undefined;
    readonly permission: DataPlanePermission;
    readonly requestTimeoutMs: number;
    readonly sandboxId: string;
    readonly strict: boolean;
  }): Promise<CredentialBundle> {
    if (!options.strict && Date.now() < this.retryAt) {
      throw new DirectDataPlaneUnavailable("Direct data-plane retry is temporarily deferred");
    }
    const existing = this.credentials.get(options.permission);
    if (
      existing !== undefined &&
      existing.expiresAt.getTime() > Date.now() + DIRECT_EXPIRY_SKEW_MS
    ) {
      return existing;
    }

    const oldCacheKey = existing?.cacheKey;
    const { csrDer, privateKeyPem } = generateP256Csr();
    const request = ConnectSandboxRequest.create({
      csrDer,
      requestedPermissions: [options.permission],
      sandboxId: options.sandboxId,
    });
    const retryDeadline =
      Date.now() + Math.min(options.requestTimeoutMs, DIRECT_CONNECT_TIMEOUT_MS);
    let retryDelayMs = 200;

    while (true) {
      try {
        let rpcTimeoutMs = Math.min(options.requestTimeoutMs, DIRECT_CREDENTIAL_RPC_TIMEOUT_MS);
        if (options.strict) {
          rpcTimeoutMs = Math.min(rpcTimeoutMs, Math.max(100, retryDeadline - Date.now()));
        } else if (options.deadline !== undefined) {
          rpcTimeoutMs = Math.max(0, options.deadline - Date.now());
          if (rpcTimeoutMs <= 0) {
            this.deferRetry();
            throw new DirectDataPlaneUnavailable("Direct data-plane credential request timed out");
          }
        }
        const response = await this.connectSandbox(request, rpcTimeoutMs);
        const bundle = credentialBundle(privateKeyPem, options.sandboxId, response);
        this.credentials.set(options.permission, bundle);
        if (oldCacheKey !== undefined && oldCacheKey !== bundle.cacheKey) {
          this.pool.discard(oldCacheKey);
        }
        return bundle;
      } catch (error) {
        if (error instanceof DirectDataPlaneUnavailable) {
          throw error;
        }
        if (!(error instanceof RpcError) || !FALLBACK_CONNECT_CODES.has(error.code)) {
          throw error;
        }
        if (
          options.strict &&
          DIRECT_READINESS_RETRY_CODES.has(error.code) &&
          Date.now() < retryDeadline
        ) {
          await sleep(retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
          continue;
        }
        this.deferRetry();
        throw new DirectDataPlaneUnavailable(
          "The direct data-plane endpoint is not currently available",
          { cause: error },
        );
      }
    }
  }

  private deferRetry(): void {
    this.retryAt = Date.now() + DIRECT_RETRY_COOLDOWN_MS;
  }
}

export function credentialBundle(
  privateKeyPem: Buffer,
  sandboxId: string,
  response: SandboxConnection,
): CredentialBundle {
  if (response.transport !== SandboxDataTransport.DIRECT_MTLS) {
    throw new DirectDataPlaneUnavailable("The server returned an unsupported data-plane transport");
  }
  if (response.protocol !== SandboxDataProtocol.CONNECT_H2_V1) {
    throw new DirectDataPlaneUnavailable("The server returned an unsupported data-plane protocol");
  }

  let secure = false;
  try {
    secure = parseGrpcTarget(response.endpointUri).secure;
  } catch (error) {
    throw new DirectDataPlaneUnavailable(
      "The server returned an invalid direct data-plane endpoint",
      {
        cause: error,
      },
    );
  }
  if (!secure) {
    throw new DirectDataPlaneUnavailable("The direct data-plane endpoint must use HTTPS");
  }

  const expiresAt = timestampToDate(response.expiresAt);
  if (expiresAt === undefined) {
    throw new DirectDataPlaneUnavailable(
      "The server returned an invalid direct data-plane certificate expiry",
    );
  }
  if (expiresAt.getTime() <= Date.now() + DIRECT_EXPIRY_SKEW_MS) {
    throw new DirectDataPlaneUnavailable("The direct data-plane certificate is already expiring");
  }
  if (response.clientCertificateChainPem.byteLength === 0) {
    throw new DirectDataPlaneUnavailable("The server returned no client certificate");
  }

  const certificateFingerprint = createHash("sha256")
    .update(Buffer.from(response.clientCertificateChainPem))
    .digest("hex");

  return {
    cacheKey: `${response.endpointId}:${sandboxId}:${certificateFingerprint}`,
    certificateChainPem: response.clientCertificateChainPem,
    endpointUri: response.endpointUri,
    expiresAt,
    grantedPermissions: new Set(response.grantedPermissions),
    privateKeyPem,
    serverCaBundlePem: response.serverCaBundlePem,
  };
}

export function createGatewayPreparedCall(
  client: DataPlaneRpcClient,
  options: PrepareDataPlaneCallOptions = {},
): PreparedDataPlaneCall {
  return createPreparedCall(client, toRpcOptions(options));
}

export function createDirectPreparedCall(lease: DirectChannelLease): PreparedDataPlaneCall {
  return createPreparedCall(lease.client, { meta: {} }, () => {
    lease.release();
  });
}

function createPreparedCall(
  client: DataPlaneRpcClient,
  rpcOptions: PreparedDataPlaneCall["rpcOptions"],
  onRelease?: () => void,
): PreparedDataPlaneCall {
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    onRelease?.();
  };

  return {
    client,
    rpcOptions,
    release,
    releaseWhenDone(done) {
      void done.finally(() => {
        release();
      });
    },
  };
}

export function requestTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs ?? DEFAULT_DATA_PLANE_REQUEST_TIMEOUT_MS;
}

export function isDirectStrict(mode: DataPlaneMode | undefined): boolean {
  return (mode ?? DEFAULT_DATA_PLANE_MODE) === "direct";
}

export function isGatewayOnly(mode: DataPlaneMode | undefined): boolean {
  return (mode ?? DEFAULT_DATA_PLANE_MODE) === "gateway";
}

function timestampToDate(timestamp: SandboxConnection["expiresAt"]): Date | undefined {
  if (timestamp === undefined) {
    return undefined;
  }
  const seconds = Number(timestamp.seconds);
  if (!Number.isFinite(seconds)) {
    return undefined;
  }
  return new Date(seconds * 1000 + Math.floor(timestamp.nanos / 1_000_000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function connectSandboxFromGatewayClient(client: SandboxServiceClient): ConnectSandboxCall {
  return async (input, timeoutMs) => {
    return client.connectSandbox(input, { timeout: timeoutMs }).response;
  };
}
