// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { BinaryReader, WireType, base64decode } from "@protobuf-ts/runtime";
import type { RpcMetadata } from "@protobuf-ts/runtime-rpc";

const STATUS_DETAILS_KEY = "grpc-status-details-bin";
const ERROR_INFO_TYPE_URL_SUFFIX = "google.rpc.ErrorInfo";

export interface ParsedErrorInfo {
  readonly reason: string;
  readonly domain: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Minimal AIP-193 parse of `grpc-status-details-bin` → ErrorInfo fields.
 *
 * Defensive: any decode failure returns undefined so callers can fall back to
 * status-code / message heuristics.
 */
export function parseErrorInfoFromMetadata(
  meta: RpcMetadata | undefined,
): ParsedErrorInfo | undefined {
  if (meta === undefined) {
    return undefined;
  }

  for (const [key, value] of Object.entries(meta)) {
    if (key.toLowerCase() !== STATUS_DETAILS_KEY) {
      continue;
    }

    for (const entry of Array.isArray(value) ? value : [value]) {
      const bytes = decodeMetadataBytes(entry);
      if (bytes === undefined) {
        continue;
      }

      const parsed = parseStatusErrorInfo(bytes);
      if (parsed !== undefined) {
        return parsed;
      }
    }
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

function parseStatusErrorInfo(statusBytes: Uint8Array): ParsedErrorInfo | undefined {
  try {
    const reader = new BinaryReader(statusBytes);
    while (reader.pos < reader.len) {
      const [fieldNo, wireType] = reader.tag();
      if (fieldNo === 3 && wireType === WireType.LengthDelimited) {
        const anyBytes = reader.bytes();
        const parsed = parseAnyErrorInfo(anyBytes);
        if (parsed !== undefined) {
          return parsed;
        }
        continue;
      }
      reader.skip(wireType);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseAnyErrorInfo(anyBytes: Uint8Array): ParsedErrorInfo | undefined {
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

  if (value === undefined || !typeUrl.endsWith(ERROR_INFO_TYPE_URL_SUFFIX)) {
    return undefined;
  }

  return parseErrorInfoMessage(value);
}

function parseErrorInfoMessage(bytes: Uint8Array): ParsedErrorInfo | undefined {
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

  if (reason.length === 0) {
    return undefined;
  }

  return { domain, metadata, reason };
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
