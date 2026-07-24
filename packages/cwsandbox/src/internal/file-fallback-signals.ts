// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxResourceExhaustedError,
  CWSandboxTransportError,
  isCWSandboxError,
} from "../errors.js";
import { CWSANDBOX_FILE_TOO_LARGE } from "./error-info.js";
import { MAX_AUTO_FALLBACK_BYTES } from "./file-limits.js";

export function isFileTooLargeReason(error: unknown): boolean {
  return error instanceof CWSandboxTransportError && error.reason === CWSANDBOX_FILE_TOO_LARGE;
}

export function parseSizeBytesFromError(error: unknown): number | undefined {
  if (!(error instanceof CWSandboxTransportError) || error.metadata === undefined) {
    return undefined;
  }

  const raw = metadataString(error.metadata, "size_bytes");
  if (raw === undefined) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

/** Write: FILE_TOO_LARGE, gRPC frame-size shape, or max-file-operation-bytes text. */
export function shouldFallbackWrite(error: unknown, size: number): boolean {
  if (size > MAX_AUTO_FALLBACK_BYTES) {
    return false;
  }

  if (isFileTooLargeReason(error)) {
    return true;
  }

  if (error instanceof CWSandboxResourceExhaustedError) {
    const text = error.message.toLowerCase();
    if (text.includes("message") && text.includes("larger than max")) {
      return true;
    }
  }

  // Backup signal when ErrorInfo is absent but the gateway message is present.
  if (isCWSandboxError(error) && error.message.toLowerCase().includes("max-file-operation-bytes")) {
    return true;
  }

  return false;
}

/**
 * Read: FILE_TOO_LARGE with size_bytes ≤ auto-fallback ceiling, or broad
 * resource-exhausted (Python parity when remote size is unknown).
 */
export function shouldFallbackRead(error: unknown): {
  readonly fallback: boolean;
  readonly expectedSize?: number;
} {
  if (isFileTooLargeReason(error)) {
    const size = parseSizeBytesFromError(error);
    if (size === undefined || size > MAX_AUTO_FALLBACK_BYTES) {
      return { fallback: false };
    }
    return { fallback: true, expectedSize: size };
  }

  if (error instanceof CWSandboxResourceExhaustedError) {
    return { fallback: true };
  }

  if (isCWSandboxError(error) && error.message.toLowerCase().includes("max-file-operation-bytes")) {
    const size = parseSizeBytesFromError(error);
    if (size !== undefined && size > MAX_AUTO_FALLBACK_BYTES) {
      return { fallback: false };
    }
    return { fallback: true, ...(size === undefined ? {} : { expectedSize: size }) };
  }

  return { fallback: false };
}

function metadataString(
  metadata: Readonly<Record<string, string | string[]>>,
  key: string,
): string | undefined {
  const value = metadata[key];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}
