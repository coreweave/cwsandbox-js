// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { BinaryWriter, WireType, base64encode } from "@protobuf-ts/runtime";

import { CWSANDBOX_ERROR_DOMAIN } from "../../../internal/error-info.js";

const ERROR_INFO_TYPE_URL = "type.googleapis.com/google.rpc.ErrorInfo";
const RETRY_INFO_TYPE_URL = "type.googleapis.com/google.rpc.RetryInfo";

export interface PackErrorInfoOptions {
  /**
   * When `""`, writes ErrorInfo field 1 as an explicit empty string so the
   * parser skips it and a later ErrorInfo can win.
   */
  readonly reason?: string;
  /** Defaults to `cwsandbox.com`. */
  readonly domain?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface PackRetryInfoOptions {
  /**
   * When both are omitted, packs an empty RetryInfo (no `retry_delay` field).
   * When either is set (including `0`), packs a Duration.
   */
  readonly retrySeconds?: number;
  readonly retryNanos?: number;
}

export interface PackStatusDetailsOptions {
  /** Defaults to `2` (UNKNOWN), matching Python fixtures. */
  readonly code?: number;
  /** Defaults to `"test"`, matching Python fixtures. */
  readonly message?: string;
  readonly errorInfos?: readonly PackErrorInfoOptions[];
  readonly retryInfos?: readonly PackRetryInfoOptions[];
}

/**
 * Serialize a `google.rpc.Status` with ErrorInfo / RetryInfo details.
 *
 * Test-only helper mirroring Python `_pack_status` / `_pack_error_info_detail`.
 */
export function packStatusDetailsBytes(options: PackStatusDetailsOptions = {}): Uint8Array {
  const writer = new BinaryWriter();
  const code = options.code ?? 2;
  const message = options.message ?? "test";

  writer.tag(1, WireType.Varint).int32(code);
  writer.tag(2, WireType.LengthDelimited).string(message);

  for (const errorInfo of options.errorInfos ?? []) {
    writer
      .tag(3, WireType.LengthDelimited)
      .bytes(packAny(ERROR_INFO_TYPE_URL, packErrorInfo(errorInfo)));
  }
  for (const retryInfo of options.retryInfos ?? []) {
    writer
      .tag(3, WireType.LengthDelimited)
      .bytes(packAny(RETRY_INFO_TYPE_URL, packRetryInfo(retryInfo)));
  }

  return writer.finish();
}

/**
 * Build `RpcError.meta` with base64-encoded `grpc-status-details-bin`.
 */
export function statusDetailsMeta(options: PackStatusDetailsOptions = {}): {
  readonly "grpc-status-details-bin": string;
} {
  return {
    "grpc-status-details-bin": base64encode(packStatusDetailsBytes(options)),
  };
}

function packAny(typeUrl: string, value: Uint8Array): Uint8Array {
  const writer = new BinaryWriter();
  writer.tag(1, WireType.LengthDelimited).string(typeUrl);
  writer.tag(2, WireType.LengthDelimited).bytes(value);
  return writer.finish();
}

function packErrorInfo(options: PackErrorInfoOptions): Uint8Array {
  const writer = new BinaryWriter();
  const reason = options.reason ?? "";
  const domain = options.domain ?? CWSANDBOX_ERROR_DOMAIN;

  // Always write reason (including "") so empty-reason cases are explicit.
  writer.tag(1, WireType.LengthDelimited).string(reason);
  writer.tag(2, WireType.LengthDelimited).string(domain);

  for (const [key, value] of Object.entries(options.metadata ?? {})) {
    writer.tag(3, WireType.LengthDelimited).bytes(packMapStringEntry(key, value));
  }

  return writer.finish();
}

function packMapStringEntry(key: string, value: string): Uint8Array {
  const writer = new BinaryWriter();
  writer.tag(1, WireType.LengthDelimited).string(key);
  writer.tag(2, WireType.LengthDelimited).string(value);
  return writer.finish();
}

function packRetryInfo(options: PackRetryInfoOptions): Uint8Array {
  const writer = new BinaryWriter();
  const hasDelay = options.retrySeconds !== undefined || options.retryNanos !== undefined;
  if (!hasDelay) {
    return writer.finish();
  }

  writer
    .tag(1, WireType.LengthDelimited)
    .bytes(packDuration(options.retrySeconds ?? 0, options.retryNanos ?? 0));
  return writer.finish();
}

function packDuration(seconds: number, nanos: number): Uint8Array {
  const writer = new BinaryWriter();
  if (seconds !== 0) {
    writer.tag(1, WireType.Varint).int64(seconds);
  }
  if (nanos !== 0) {
    writer.tag(2, WireType.Varint).int32(nanos);
  }
  // Explicit zero duration: write seconds field as 0 so HasField-style presence
  // is represented (empty Duration bytes still parse as 0ms).
  if (seconds === 0 && nanos === 0) {
    writer.tag(1, WireType.Varint).int64(0);
  }
  return writer.finish();
}
