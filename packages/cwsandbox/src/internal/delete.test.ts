// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxNotFoundError, CWSandboxTransportError } from "../errors.js";
import { ignoreMissingSandbox } from "./delete.js";
import { CWSANDBOX_ERROR_DOMAIN, CWSANDBOX_SANDBOX_NOT_FOUND } from "./error-info.js";

describe("ignoreMissingSandbox", () => {
  it("resolves when the operation succeeds", async () => {
    await expect(ignoreMissingSandbox(Promise.resolve(), true)).resolves.toBeUndefined();
  });

  it("swallows not-found when missingOk is true", async () => {
    await expect(
      ignoreMissingSandbox(Promise.reject(new CWSandboxNotFoundError("missing")), true),
    ).resolves.toBeUndefined();
  });

  it("swallows trusted reason-mapped not-found when missingOk is true", async () => {
    await expect(
      ignoreMissingSandbox(
        Promise.reject(
          new CWSandboxTransportError("gone", {
            domain: CWSANDBOX_ERROR_DOMAIN,
            reason: CWSANDBOX_SANDBOX_NOT_FOUND,
          }),
        ),
        true,
      ),
    ).resolves.toBeUndefined();
  });

  it("rethrows not-found when missingOk is false", async () => {
    const error = new CWSandboxNotFoundError("missing");
    await expect(ignoreMissingSandbox(Promise.reject(error), false)).rejects.toBe(error);
  });

  it("rethrows non-not-found errors even when missingOk is true", async () => {
    const error = new Error("boom");
    await expect(ignoreMissingSandbox(Promise.reject(error), true)).rejects.toBe(error);
  });
});
