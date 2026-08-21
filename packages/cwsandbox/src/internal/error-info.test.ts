// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxNotFoundError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
} from "../errors.js";
import {
  CWSANDBOX_ERROR_DOMAIN,
  CWSANDBOX_SANDBOX_NOT_FOUND,
  isSandboxNotFound,
} from "./error-info.js";

describe("isSandboxNotFound", () => {
  it("returns true for CWSandboxNotFoundError from a snapshot miss", () => {
    expect(isSandboxNotFound(new CWSandboxNotFoundError("snapshot missing"))).toBe(true);
  });

  it("returns true for trusted sandbox-not-found reason on any transport error", () => {
    const error = new CWSandboxUnavailableError("gone", {
      domain: CWSANDBOX_ERROR_DOMAIN,
      reason: CWSANDBOX_SANDBOX_NOT_FOUND,
    });

    expect(isSandboxNotFound(error)).toBe(true);
  });

  it("returns false for untrusted domain", () => {
    const error = new CWSandboxTransportError("gone", {
      domain: "evil.example.com",
      reason: CWSANDBOX_SANDBOX_NOT_FOUND,
    });

    expect(isSandboxNotFound(error)).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isSandboxNotFound(new Error("boom"))).toBe(false);
    expect(
      isSandboxNotFound(
        new CWSandboxTransportError("down", {
          domain: CWSANDBOX_ERROR_DOMAIN,
          reason: "CWSANDBOX_BACKEND_UNAVAILABLE",
        }),
      ),
    ).toBe(false);
  });
});
