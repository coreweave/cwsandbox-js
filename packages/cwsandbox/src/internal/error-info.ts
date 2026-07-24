// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxNotFoundError, CWSandboxTransportError } from "../errors.js";

/** Domain value used by the CoreWeave backend when emitting ErrorInfo. */
export const CWSANDBOX_ERROR_DOMAIN = "cwsandbox.com";

// File operation reasons
export const CWSANDBOX_FILE_NOT_FOUND = "CWSANDBOX_FILE_NOT_FOUND";
export const CWSANDBOX_FILE_IS_DIRECTORY = "CWSANDBOX_FILE_IS_DIRECTORY";
export const CWSANDBOX_FILE_IO_FAILED = "CWSANDBOX_FILE_IO_FAILED";
export const CWSANDBOX_FILE_PERMISSION_DENIED = "CWSANDBOX_FILE_PERMISSION_DENIED";
/** Size-policy refusal for unary file ops; prefer StreamExec / streaming APIs. */
export const CWSANDBOX_FILE_TOO_LARGE = "CWSANDBOX_FILE_TOO_LARGE";
export const CWSANDBOX_FILE_TRUNCATED = "CWSANDBOX_FILE_TRUNCATED";

export const FILE_ERROR_REASONS: ReadonlySet<string> = new Set([
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_IS_DIRECTORY,
  CWSANDBOX_FILE_IO_FAILED,
  CWSANDBOX_FILE_PERMISSION_DENIED,
  CWSANDBOX_FILE_TOO_LARGE,
  CWSANDBOX_FILE_TRUNCATED,
]);

// Not-found reasons per context
export const CWSANDBOX_SANDBOX_NOT_FOUND = "CWSANDBOX_SANDBOX_NOT_FOUND";
export const CWSANDBOX_RUNNER_NOT_FOUND = "CWSANDBOX_RUNNER_NOT_FOUND";
export const CWSANDBOX_PROFILE_NOT_FOUND = "CWSANDBOX_PROFILE_NOT_FOUND";

// Timeout reasons
export const CWSANDBOX_COMMAND_TIMEOUT = "CWSANDBOX_COMMAND_TIMEOUT";

// Unavailable reasons
export const CWSANDBOX_RUNNER_UNAVAILABLE = "CWSANDBOX_RUNNER_UNAVAILABLE";
export const CWSANDBOX_BACKEND_UNAVAILABLE = "CWSANDBOX_BACKEND_UNAVAILABLE";

export const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  CWSANDBOX_RUNNER_UNAVAILABLE,
  CWSANDBOX_BACKEND_UNAVAILABLE,
]);

/**
 * Return true if `error` represents a sandbox not-found condition.
 *
 * Honors both the mapped `CWSandboxNotFoundError` class (gRPC NOT_FOUND or a
 * trusted AIP-193 sandbox-not-found reason) and a trusted reason on any
 * transport error when domain gating matches.
 */
export function isSandboxNotFound(
  error: unknown,
  reason: string = CWSANDBOX_SANDBOX_NOT_FOUND,
): boolean {
  if (error instanceof CWSandboxNotFoundError) {
    return true;
  }

  if (!(error instanceof CWSandboxTransportError)) {
    return false;
  }

  return error.domain === CWSANDBOX_ERROR_DOMAIN && error.reason === reason;
}
