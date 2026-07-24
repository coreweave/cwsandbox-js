// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxNotFoundError, CWSandboxTransportError, type SandboxTransport } from "./index.js";
import { CWSANDBOX_ERROR_DOMAIN, CWSANDBOX_SANDBOX_NOT_FOUND } from "./internal/error-info.js";
import { createClient, createFakeTransport } from "./test/helpers.js";

/**
 * Mirrors Python `_NOT_FOUND_PAIRS`: status NOT_FOUND with no reason, plus
 * trusted AIP-193 sandbox-not-found on non-NOT_FOUND status codes.
 *
 * Errors are shaped like `mapGrpcError` output (covered separately) so this
 * file stays outside the node-grpc import boundary.
 */
const NOT_FOUND_PAIRS = [
  {
    code: "NOT_FOUND",
    error: () =>
      new CWSandboxNotFoundError("Not found", {
        operation: "Stop sandbox",
        sandboxId: "sandbox-for-echo",
        transport: "grpc",
        transportCode: "NOT_FOUND",
      }),
  },
  {
    code: "INTERNAL",
    error: () =>
      new CWSandboxNotFoundError("Not found", {
        domain: CWSANDBOX_ERROR_DOMAIN,
        operation: "Stop sandbox",
        reason: CWSANDBOX_SANDBOX_NOT_FOUND,
        sandboxId: "sandbox-for-echo",
        transport: "grpc",
        transportCode: "INTERNAL",
      }),
  },
  {
    code: "FAILED_PRECONDITION",
    error: () =>
      new CWSandboxNotFoundError("Not found", {
        domain: CWSANDBOX_ERROR_DOMAIN,
        operation: "Stop sandbox",
        reason: CWSANDBOX_SANDBOX_NOT_FOUND,
        sandboxId: "sandbox-for-echo",
        transport: "grpc",
        transportCode: "FAILED_PRECONDITION",
      }),
  },
] as const;

async function createReadySandbox(overrides: Partial<SandboxTransport> = {}) {
  const base = createFakeTransport();
  const transport: SandboxTransport = {
    ...base,
    ...overrides,
  };
  return createClient(transport).run(["echo", "hello"]);
}

describe("Sandbox missingOk matrix", () => {
  describe("stop", () => {
    it.each(NOT_FOUND_PAIRS)(
      "swallows $code not-found when missingOk is true",
      async ({ error }) => {
        const mapped = error();
        const sandbox = await createReadySandbox({
          async stop() {
            throw mapped;
          },
        });

        await expect(sandbox.stop({ missingOk: true })).resolves.toBeUndefined();
      },
    );

    it.each(NOT_FOUND_PAIRS)(
      "raises not-found for $code when missingOk is false",
      async ({ error }) => {
        const mapped = error();
        const sandbox = await createReadySandbox({
          async stop() {
            throw mapped;
          },
        });

        await expect(sandbox.stop()).rejects.toBeInstanceOf(CWSandboxNotFoundError);
      },
    );

    it("raises generic transport error for INTERNAL without a matching reason", async () => {
      const error = new CWSandboxTransportError("Stop sandbox failed: server error", {
        operation: "Stop sandbox",
        sandboxId: "sandbox-for-echo",
        transport: "grpc",
        transportCode: "INTERNAL",
      });

      const sandboxStrict = await createReadySandbox({
        async stop() {
          throw error;
        },
      });
      await expect(sandboxStrict.stop()).rejects.toBe(error);

      const sandboxMissingOk = await createReadySandbox({
        async stop() {
          throw error;
        },
      });
      await expect(sandboxMissingOk.stop({ missingOk: true })).rejects.toBe(error);
    });
  });

  describe("delete", () => {
    it.each(NOT_FOUND_PAIRS)(
      "swallows $code not-found when missingOk is true",
      async ({ error }) => {
        const mapped = error();
        const sandbox = await createReadySandbox({
          async delete() {
            throw mapped;
          },
        });

        await expect(sandbox.delete({ missingOk: true })).resolves.toBeUndefined();
      },
    );

    it.each(NOT_FOUND_PAIRS)(
      "raises not-found for $code when missingOk is false",
      async ({ error }) => {
        const mapped = error();
        const sandbox = await createReadySandbox({
          async delete() {
            throw mapped;
          },
        });

        await expect(sandbox.delete()).rejects.toBeInstanceOf(CWSandboxNotFoundError);
      },
    );

    it("raises generic transport error for INTERNAL without a matching reason", async () => {
      const error = new CWSandboxTransportError("Delete sandbox failed: server error", {
        operation: "Delete sandbox",
        sandboxId: "sandbox-for-echo",
        transport: "grpc",
        transportCode: "INTERNAL",
      });

      const sandbox = await createReadySandbox({
        async delete() {
          throw error;
        },
      });

      await expect(sandbox.delete()).rejects.toBe(error);
      await expect(sandbox.delete({ missingOk: true })).rejects.toBe(error);
    });
  });
});
