// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import "reflect-metadata";
import { createHash, webcrypto } from "node:crypto";

import { ChannelCredentials, Client } from "@grpc/grpc-js";
import { Pkcs10CertificateRequestGenerator } from "@peculiar/x509";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { RpcError } from "@protobuf-ts/runtime-rpc";

import { CWSandboxUnavailableError } from "../../errors.js";
import type { DataPlaneMode } from "../../public/data-plane.js";
import { GRPC_CLIENT_OPTIONS } from "./channel.js";
import { mapGrpcError } from "./errors.js";
import type { SandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";
import {
  SandboxDataProtocol,
  SandboxDataTransport,
  type SandboxConnection,
  type SandboxDataPermission,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import { SandboxDataPlaneServiceClient } from "./generated/coreweave/sandbox/v1/sandbox_data_plane.client.js";

const AUTO_BUDGET_MS = 1_000;
const DIRECT_BUDGET_MS = 10_000;
const CREDENTIAL_RPC_TIMEOUT_MS = 5_000;
const RETRY_COOLDOWN_MS = 30_000;
const EXPIRY_SKEW_MS = 30_000;
const MAX_IDLE_CHANNELS = 64;
const MAX_SANDBOX_STATES = 2_048;
const STRICT_RETRY_START_MS = 200;

const FALLBACK_CODES = new Set([
  "DEADLINE_EXCEEDED",
  "FAILED_PRECONDITION",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "UNIMPLEMENTED",
]);

class DirectDataPlaneUnavailable extends Error {}
class DirectDataPlanePermissionUnavailable extends Error {}

interface CredentialBundle {
  readonly cacheKey: string;
  readonly certificateChain: Buffer;
  readonly expiresAtMs: number;
  readonly grantedPermissions: ReadonlySet<SandboxDataPermission>;
  readonly host: string;
  readonly privateKey: Buffer;
  readonly rootCertificate?: Buffer;
}

interface DirectChannel {
  readonly client: SandboxDataPlaneServiceClient;
  close(): void;
  ready: Promise<void>;
}

interface PoolEntry {
  activeLeases: number;
  readonly channel: DirectChannel;
  closed: boolean;
  discardWhenIdle: boolean;
}

export interface DirectDataPlaneLease {
  readonly client: SandboxDataPlaneServiceClient;
  discard(): Promise<void>;
  release(options?: { readonly discard?: boolean }): Promise<void>;
}

interface AcquireOptions {
  readonly dataPlaneMode: DataPlaneMode;
  readonly permission: SandboxDataPermission;
  readonly sandboxId: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface SandboxState {
  readonly credentials: Map<SandboxDataPermission, CredentialBundle>;
  readonly pendingCredentials: Map<SandboxDataPermission, Promise<CredentialBundle>>;
  retryAtMs: number;
}

type ChannelFactory = (bundle: CredentialBundle) => DirectChannel;

/** Process-wide bounded cache. Active streams are never evicted. */
export class DirectChannelPool {
  private readonly entries = new Map<string, PoolEntry>();

  public constructor(
    private readonly maxIdleChannels = MAX_IDLE_CHANNELS,
    private readonly channelFactory: ChannelFactory = createDirectChannel,
  ) {}

  public async acquire(
    bundle: CredentialBundle,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DirectDataPlaneLease> {
    let entry = this.entries.get(bundle.cacheKey);
    if (entry === undefined) {
      let channel: DirectChannel;
      try {
        channel = this.channelFactory(bundle);
      } catch (error) {
        throw new DirectDataPlaneUnavailable("could not create the direct mTLS channel", {
          cause: error,
        });
      }
      entry = {
        activeLeases: 0,
        channel,
        closed: false,
        discardWhenIdle: false,
      };
      this.entries.set(bundle.cacheKey, entry);
    }

    entry.activeLeases += 1;
    this.touch(bundle.cacheKey, entry);

    let released = false;
    const release = async (options: { readonly discard?: boolean } = {}): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      this.release(bundle.cacheKey, entry, options.discard === true);
    };

    try {
      await within(
        entry.channel.ready,
        timeoutMs,
        signal,
        "Direct data-plane connection timed out",
      );
    } catch (error) {
      await release({ discard: true });
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      throw new DirectDataPlaneUnavailable("could not connect to the direct endpoint", {
        cause: error,
      });
    }

    return {
      client: entry.channel.client,
      discard: async () => this.discardEntry(bundle.cacheKey, entry),
      release,
    };
  }

  public discard(cacheKey: string): void {
    const entry = this.entries.get(cacheKey);
    if (entry !== undefined) {
      this.discardEntry(cacheKey, entry);
    }
  }

  private discardEntry(cacheKey: string, entry: PoolEntry): void {
    entry.discardWhenIdle = true;
    if (this.entries.get(cacheKey) === entry) {
      this.entries.delete(cacheKey);
    }
    if (entry.activeLeases === 0) {
      this.close(entry);
    }
  }

  private release(cacheKey: string, entry: PoolEntry, discard: boolean): void {
    entry.activeLeases = Math.max(0, entry.activeLeases - 1);
    entry.discardWhenIdle ||= discard;
    if (discard && this.entries.get(cacheKey) === entry) {
      this.entries.delete(cacheKey);
    } else if (this.entries.get(cacheKey) === entry) {
      this.touch(cacheKey, entry);
    }
    if (entry.activeLeases === 0 && entry.discardWhenIdle) {
      if (this.entries.get(cacheKey) === entry) {
        this.entries.delete(cacheKey);
      }
      this.close(entry);
    }
    this.evictIdle();
  }

  private close(entry: PoolEntry): void {
    if (entry.closed) {
      return;
    }
    entry.closed = true;
    entry.channel.close();
  }

  private touch(cacheKey: string, entry: PoolEntry): void {
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
  }

  private evictIdle(): void {
    let idleCount = [...this.entries.values()].filter((entry) => entry.activeLeases === 0).length;
    if (idleCount <= this.maxIdleChannels) {
      return;
    }
    for (const [cacheKey, entry] of this.entries) {
      if (idleCount <= this.maxIdleChannels) {
        return;
      }
      if (entry.activeLeases !== 0) {
        continue;
      }
      this.entries.delete(cacheKey);
      this.close(entry);
      idleCount -= 1;
    }
  }
}

const CHANNEL_POOL = new DirectChannelPool();

export class DirectDataPlane {
  private readonly states = new Map<string, SandboxState>();

  public constructor(
    private readonly controlClient: SandboxServiceClient,
    private readonly pool: DirectChannelPool = CHANNEL_POOL,
  ) {}

  public async acquire(options: AcquireOptions): Promise<DirectDataPlaneLease | undefined> {
    if (options.dataPlaneMode === "gateway") {
      return undefined;
    }

    try {
      return await this.acquireDirect(options);
    } catch (error) {
      if (
        error instanceof DirectDataPlaneUnavailable ||
        error instanceof DirectDataPlanePermissionUnavailable
      ) {
        if (options.dataPlaneMode === "auto") {
          return undefined;
        }
        throw new CWSandboxUnavailableError(
          `Direct data-plane access is unavailable for sandbox '${options.sandboxId}': ${error.message}`,
          {
            cause: error,
            operation: "Connect to sandbox data plane",
            sandboxId: options.sandboxId,
            transport: "grpc",
          },
        );
      }
      if (error instanceof RpcError) {
        throw mapGrpcError(error, {
          operation: "Connect to sandbox data plane",
          sandboxId: options.sandboxId,
        });
      }
      throw error;
    }
  }

  public discardSandbox(sandboxId: string): void {
    const state = this.states.get(sandboxId);
    if (state === undefined) {
      return;
    }
    this.states.delete(sandboxId);
    for (const bundle of state.credentials.values()) {
      this.pool.discard(bundle.cacheKey);
    }
  }

  private async acquireDirect(options: AcquireOptions): Promise<DirectDataPlaneLease> {
    const state = this.stateFor(options.sandboxId);
    if (options.dataPlaneMode === "auto" && Date.now() < state.retryAtMs) {
      throw new DirectDataPlaneUnavailable("direct connection retry is temporarily deferred");
    }

    const modeBudget = options.dataPlaneMode === "direct" ? DIRECT_BUDGET_MS : AUTO_BUDGET_MS;
    const budgetMs = Math.min(options.timeoutMs ?? modeBudget, modeBudget);
    const deadlineMs = Date.now() + budgetMs;
    let retryDelayMs = STRICT_RETRY_START_MS;

    while (true) {
      try {
        const bundle = await within(
          this.ensureCredential(options.sandboxId, options.permission, state),
          remainingMs(deadlineMs),
          options.signal,
          "Direct data-plane credential request timed out",
        );
        if (!bundle.grantedPermissions.has(options.permission)) {
          throw new DirectDataPlanePermissionUnavailable(
            `certificate does not grant permission ${options.permission}`,
          );
        }

        const lease = await this.pool.acquire(bundle, remainingMs(deadlineMs), options.signal);
        state.retryAtMs = 0;
        return lease;
      } catch (error) {
        const retryable =
          options.dataPlaneMode === "direct" &&
          error instanceof RpcError &&
          error.code === "UNAVAILABLE" &&
          remainingMs(deadlineMs) > retryDelayMs;
        if (retryable) {
          await delay(retryDelayMs, options.signal);
          retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
          continue;
        }
        if (isFallbackError(error)) {
          state.retryAtMs = Date.now() + RETRY_COOLDOWN_MS;
          throw new DirectDataPlaneUnavailable("direct endpoint is not currently available", {
            cause: error,
          });
        }
        throw error;
      }
    }
  }

  private ensureCredential(
    sandboxId: string,
    permission: SandboxDataPermission,
    state: SandboxState,
  ): Promise<CredentialBundle> {
    const cached = state.credentials.get(permission);
    if (cached !== undefined && cached.expiresAtMs > Date.now() + EXPIRY_SKEW_MS) {
      return Promise.resolve(cached);
    }

    const pending = state.pendingCredentials.get(permission);
    if (pending !== undefined) {
      return pending;
    }

    const issue = this.issueCredential(sandboxId, permission).then(async (bundle) => {
      const replaced = state.credentials.get(permission);
      state.credentials.set(permission, bundle);
      if (replaced !== undefined && replaced.cacheKey !== bundle.cacheKey) {
        this.pool.discard(replaced.cacheKey);
      }
      return bundle;
    });
    state.pendingCredentials.set(permission, issue);
    void issue
      .finally(() => {
        state.pendingCredentials.delete(permission);
        this.trimStates();
      })
      .catch(() => undefined);
    return issue;
  }

  private async issueCredential(
    sandboxId: string,
    permission: SandboxDataPermission,
  ): Promise<CredentialBundle> {
    const algorithm = { hash: "SHA-256", name: "ECDSA", namedCurve: "P-256" } as const;
    let csrDer: Uint8Array;
    let privateKeyDer: ArrayBuffer;
    try {
      const keys = await webcrypto.subtle.generateKey(
        { name: algorithm.name, namedCurve: algorithm.namedCurve },
        true,
        ["sign", "verify"],
      );
      const csr = await Pkcs10CertificateRequestGenerator.create(
        { keys, name: "", signingAlgorithm: algorithm },
        webcrypto,
      );
      csrDer = new Uint8Array(csr.rawData);
      privateKeyDer = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
    } catch (error) {
      throw new DirectDataPlaneUnavailable("could not create direct client credentials", {
        cause: error,
      });
    }
    const response = await this.controlClient.connectSandbox(
      {
        csrDer,
        requestedPermissions: [permission],
        sandboxId,
      },
      { timeout: CREDENTIAL_RPC_TIMEOUT_MS },
    ).response;
    return credentialBundle(privateKeyDer, sandboxId, response);
  }

  private stateFor(sandboxId: string): SandboxState {
    let state = this.states.get(sandboxId);
    if (state === undefined) {
      state = { credentials: new Map(), pendingCredentials: new Map(), retryAtMs: 0 };
      this.states.set(sandboxId, state);
      this.trimStates();
    } else {
      this.states.delete(sandboxId);
      this.states.set(sandboxId, state);
    }
    return state;
  }

  private trimStates(): void {
    if (this.states.size <= MAX_SANDBOX_STATES) {
      return;
    }
    for (const [sandboxId, state] of this.states) {
      if (this.states.size <= MAX_SANDBOX_STATES) {
        return;
      }
      if (state.pendingCredentials.size === 0) {
        this.discardSandbox(sandboxId);
      }
    }
  }
}

function credentialBundle(
  privateKeyDer: ArrayBuffer,
  sandboxId: string,
  response: SandboxConnection,
): CredentialBundle {
  if (response.transport !== SandboxDataTransport.DIRECT_MTLS) {
    throw new DirectDataPlaneUnavailable("server returned an unsupported transport");
  }
  if (response.protocol !== SandboxDataProtocol.CONNECT_H2_V1) {
    throw new DirectDataPlaneUnavailable("server returned an unsupported protocol");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(response.endpointUri);
  } catch (error) {
    throw new DirectDataPlaneUnavailable("server returned an invalid endpoint", { cause: error });
  }
  if (endpoint.protocol !== "https:") {
    throw new DirectDataPlaneUnavailable("direct endpoint must use HTTPS");
  }

  const expiresAtMs = timestampMs(response);
  if (expiresAtMs <= Date.now() + EXPIRY_SKEW_MS) {
    throw new DirectDataPlaneUnavailable("client certificate is already expiring");
  }

  const certificateChain = Buffer.from(response.clientCertificateChainPem);
  if (certificateChain.byteLength === 0) {
    throw new DirectDataPlaneUnavailable("server returned no client certificate");
  }
  const fingerprint = createHash("sha256").update(certificateChain).digest("hex");
  const rootCertificate = Buffer.from(response.serverCaBundlePem);

  return {
    cacheKey: `${response.endpointId}:${sandboxId}:${fingerprint}`,
    certificateChain,
    expiresAtMs,
    grantedPermissions: new Set(response.grantedPermissions),
    host: endpoint.host,
    privateKey: Buffer.from(toPem("PRIVATE KEY", privateKeyDer)),
    ...(rootCertificate.byteLength === 0 ? {} : { rootCertificate }),
  };
}

function createDirectChannel(bundle: CredentialBundle): DirectChannel {
  const credentials = ChannelCredentials.createSsl(
    bundle.rootCertificate,
    bundle.privateKey,
    bundle.certificateChain,
  );
  const owner = new Client(bundle.host, credentials, GRPC_CLIENT_OPTIONS);
  const transport = new GrpcTransport({
    channelCredentials: credentials,
    clientOptions: { ...GRPC_CLIENT_OPTIONS, channelOverride: owner.getChannel() },
    host: bundle.host,
  });
  const ready = new Promise<void>((resolve, reject) => {
    owner.waitForReady(Date.now() + DIRECT_BUDGET_MS, (error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  void ready.catch(() => undefined);

  return {
    client: new SandboxDataPlaneServiceClient(transport),
    close() {
      transport.close();
    },
    ready,
  };
}

function timestampMs(response: SandboxConnection): number {
  if (response.expiresAt === undefined) {
    throw new DirectDataPlaneUnavailable("server returned no certificate expiry");
  }
  const seconds = Number(response.expiresAt.seconds);
  const nanos = response.expiresAt.nanos;
  const milliseconds = seconds * 1_000 + nanos / 1_000_000;
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos >= 1_000_000_000 ||
    !Number.isFinite(milliseconds)
  ) {
    throw new DirectDataPlaneUnavailable("server returned an invalid certificate expiry");
  }
  return milliseconds;
}

function toPem(label: string, der: ArrayBuffer): string {
  const encoded = Buffer.from(der).toString("base64");
  const lines = encoded.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

function isFallbackError(error: unknown): boolean {
  return (
    error instanceof DirectDataPlaneUnavailable ||
    (error instanceof RpcError && FALLBACK_CODES.has(error.code))
  );
}

function within<TResult>(
  promise: Promise<TResult>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<TResult> {
  if (signal?.aborted === true) {
    return Promise.reject(signal.reason);
  }
  if (timeoutMs <= 0) {
    return Promise.reject(new DirectDataPlaneUnavailable(timeoutMessage));
  }

  return new Promise<TResult>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timeout = setTimeout(
      () => settle(() => reject(new DirectDataPlaneUnavailable(timeoutMessage))),
      timeoutMs,
    );
    const onAbort = (): void => settle(() => reject(signal?.reason));
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function delay(timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(signal.reason);
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
