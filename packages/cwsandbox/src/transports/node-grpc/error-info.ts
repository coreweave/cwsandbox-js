// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { BinaryReader, WireType, base64decode } from "@protobuf-ts/runtime";
import type { RpcMetadata } from "@protobuf-ts/runtime-rpc";

const STATUS_DETAILS_KEY = "grpc-status-details-bin";
const ERROR_INFO_TYPE_URL_SUFFIX = "google.rpc.ErrorInfo";
const RETRY_INFO_TYPE_URL_SUFFIX = "google.rpc.RetryInfo";
const MAX_SAFE_DELAY_SECONDS = Number.MAX_SAFE_INTEGER / 1000;

export interface ParsedStatusDetails {
  readonly reason?: string;
  readonly domain: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly retryDelayMs?: number;
}

/**
 * Parse AIP-193 `google.rpc.Status` details from `grpc-status-details-bin`.
 *
 * Defensive: any decode failure returns undefined so callers can fall back to
 * status-code mapping. Never throws.
 */
export function parseStatusDetailsFromMetadata(
  meta: RpcMetadata | undefined,
): ParsedStatusDetails | undefined {
  if (meta === undefined) {
    return undefined;
  }

  try {
    for (const [key, value] of Object.entries(meta)) {
      if (key.toLowerCase() !== STATUS_DETAILS_KEY) {
        continue;
      }

      for (const entry of Array.isArray(value) ? value : [value]) {
        const bytes = decodeMetadataBytes(entry);
        if (bytes === undefined) {
          continue;
        }

        const parsed = parseStatusMessage(bytes);
        if (parsed !== undefined) {
          return parsed;
        }
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function decodeMetadataBytes(value: string): Uint8Array | undefined {
  if (value.length === 0) {
    return undefined;
  }

  try {
    return base64decode(value);
  } catch {
    return undefined;
  }
}

function parseStatusMessage(statusBytes: Uint8Array): ParsedStatusDetails | undefined {
  try {
    let reason: string | undefined;
    let domain = "";
    let metadata: Readonly<Record<string, string>> = {};
    let retryDelayMs: number | undefined;

    const reader = new BinaryReader(statusBytes);
    while (reader.pos < reader.len) {
      const [fieldNo, wireType] = reader.tag();
      if (fieldNo === 3 && wireType === WireType.LengthDelimited) {
        const anyBytes = reader.bytes();
        const detail = parseAnyDetail(anyBytes);
        if (detail === undefined) {
          continue;
        }

        if (detail.kind === "errorInfo" && reason === undefined) {
          reason = detail.reason;
          domain = detail.domain;
          metadata = detail.metadata;
        } else if (detail.kind === "retryInfo" && retryDelayMs === undefined) {
          retryDelayMs = detail.retryDelayMs;
        }

        if (reason !== undefined && retryDelayMs !== undefined) {
          break;
        }
        continue;
      }
      reader.skip(wireType);
    }

    if (reason === undefined && retryDelayMs === undefined) {
      return undefined;
    }

    return {
      domain,
      metadata,
      ...(reason === undefined ? {} : { reason }),
      ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    };
  } catch {
    return undefined;
  }
}

type ParsedAnyDetail =
  | {
      readonly kind: "errorInfo";
      readonly reason: string;
      readonly domain: string;
      readonly metadata: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "retryInfo";
      readonly retryDelayMs: number;
    };

function parseAnyDetail(anyBytes: Uint8Array): ParsedAnyDetail | undefined {
  let typeUrl = "";
  let value: Uint8Array | undefined;

  const reader = new BinaryReader(anyBytes);
  while (reader.pos < reader.len) {
    const [fieldNo, wireType] = reader.tag();
    if (fieldNo === 1 && wireType === WireType.LengthDelimited) {
      typeUrl = reader.string();
      continue;
    }
    if (fieldNo === 2 && wireType === WireType.LengthDelimited) {
      value = reader.bytes();
      continue;
    }
    reader.skip(wireType);
  }

  if (value === undefined) {
    return undefined;
  }

  if (typeUrl.endsWith(ERROR_INFO_TYPE_URL_SUFFIX)) {
    return parseErrorInfoMessage(value);
  }
  if (typeUrl.endsWith(RETRY_INFO_TYPE_URL_SUFFIX)) {
    return parseRetryInfoMessage(value);
  }

  return undefined;
}

function parseErrorInfoMessage(bytes: Uint8Array): ParsedAnyDetail | undefined {
  let reason = "";
  let domain = "";
  const metadata: Record<string, string> = {};

  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [fieldNo, wireType] = reader.tag();
    if (fieldNo === 1 && wireType === WireType.LengthDelimited) {
      reason = reader.string();
      continue;
    }
    if (fieldNo === 2 && wireType === WireType.LengthDelimited) {
      domain = reader.string();
      continue;
    }
    if (fieldNo === 3 && wireType === WireType.LengthDelimited) {
      const entry = parseMapStringEntry(reader.bytes());
      if (entry !== undefined) {
        metadata[entry.key] = entry.value;
      }
      continue;
    }
    reader.skip(wireType);
  }

  // Empty proto3 reason is "not present" so a later ErrorInfo can still win.
  if (reason.length === 0) {
    return undefined;
  }

  return { kind: "errorInfo", domain, metadata, reason };
}

function parseRetryInfoMessage(bytes: Uint8Array): ParsedAnyDetail | undefined {
  let hasRetryDelay = false;
  let durationBytes: Uint8Array | undefined;

  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [fieldNo, wireType] = reader.tag();
    if (fieldNo === 1 && wireType === WireType.LengthDelimited) {
      hasRetryDelay = true;
      durationBytes = reader.bytes();
      continue;
    }
    reader.skip(wireType);
  }

  // Absent retry_delay looks like no field 1; skip so a later RetryInfo can win.
  if (!hasRetryDelay) {
    return undefined;
  }

  const retryDelayMs = durationToMs(durationBytes ?? new Uint8Array());
  if (retryDelayMs === undefined) {
    return undefined;
  }

  return { kind: "retryInfo", retryDelayMs };
}

function durationToMs(bytes: Uint8Array): number | undefined {
  let seconds = 0;
  let nanos = 0;

  try {
    const reader = new BinaryReader(bytes);
    while (reader.pos < reader.len) {
      const [fieldNo, wireType] = reader.tag();
      if (fieldNo === 1 && wireType === WireType.Varint) {
        seconds = Number(reader.int64());
        continue;
      }
      if (fieldNo === 2 && wireType === WireType.Varint) {
        nanos = reader.int32();
        continue;
      }
      reader.skip(wireType);
    }
  } catch {
    return undefined;
  }

  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    return undefined;
  }
  if (Math.abs(seconds) > MAX_SAFE_DELAY_SECONDS) {
    return undefined;
  }

  const ms = seconds * 1000 + nanos / 1_000_000;
  if (!Number.isFinite(ms)) {
    return undefined;
  }

  return ms;
}

function parseMapStringEntry(
  bytes: Uint8Array,
): { readonly key: string; readonly value: string } | undefined {
  let key = "";
  let value = "";

  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [fieldNo, wireType] = reader.tag();
    if (fieldNo === 1 && wireType === WireType.LengthDelimited) {
      key = reader.string();
      continue;
    }
    if (fieldNo === 2 && wireType === WireType.LengthDelimited) {
      value = reader.string();
      continue;
    }
    reader.skip(wireType);
  }

  if (key.length === 0) {
    return undefined;
  }

  return { key, value };
}
