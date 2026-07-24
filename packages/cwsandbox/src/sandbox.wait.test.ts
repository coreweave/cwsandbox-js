// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSandboxNotFoundError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
  CWSandboxValidationError,
  type SandboxTransport,
} from "./index.js";
import { createClient, createFakeTransport } from "./test/helpers.js";

describe("Sandbox status and wait", () => {
  it("gets the current sandbox status", async () => {
    const sandbox = await createClient(createFakeTransport(["creating"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.getStatus()).resolves.toBe("creating");
  });

  it("forwards getStatus options to the transport", async () => {
    const signal = new AbortController().signal;
    let getRequest: Parameters<SandboxTransport["get"]>[0] | undefined;
    const transport: SandboxTransport = {
      ...createFakeTransport(["running"]),
      async get(request) {
        getRequest = request;
        return {
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await sandbox.getStatus({ signal, timeoutMs: 1234 });

    expect(getRequest).toEqual({
      sandboxId: "sandbox-for-echo",
      signal,
      timeoutMs: 1234,
    });
  });

  it("waits until the sandbox is running", async () => {
    const sandbox = await createClient(createFakeTransport(["creating", "running"])).run(
      ["echo", "hello"],
      {
        waitUntilRunning: false,
      },
    );

    await expect(sandbox.wait({ intervalMs: 1, timeoutMs: 100 })).resolves.toBe(sandbox);
  });

  it("retries transient unavailable status checks while waiting", async () => {
    let getCalls = 0;
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get(request) {
        getCalls += 1;
        if (getCalls === 1) {
          throw new CWSandboxUnavailableError("try again");
        }

        return {
          sandboxId: request.sandboxId,
          status: "running",
        };
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait({ intervalMs: 1, timeoutMs: 100 })).resolves.toBe(sandbox);
    expect(getCalls).toBe(2);
  });

  it("waits until the requested target status", async () => {
    const sandbox = await createClient(createFakeTransport(["creating", "completed"])).run(
      ["echo", "hello"],
      {
        waitUntilRunning: false,
      },
    );

    await expect(
      sandbox.wait({ intervalMs: 1, targetStatus: "completed", timeoutMs: 100 }),
    ).resolves.toBe(sandbox);
  });

  it("waits until any terminal status when targetStatus is terminal", async () => {
    const sandbox = await createClient(createFakeTransport(["terminating", "failed"])).run(
      ["echo", "hello"],
      {
        waitUntilRunning: false,
      },
    );

    await expect(
      sandbox.wait({ intervalMs: 1, targetStatus: "terminal", timeoutMs: 100 }),
    ).resolves.toBe(sandbox);
    expect(sandbox.status).toBe("failed");
  });

  it("keeps NotFound fatal for observe-only terminal waits", async () => {
    const transport: SandboxTransport = {
      ...createFakeTransport(),
      async get() {
        throw new CWSandboxNotFoundError("missing");
      },
    };
    const sandbox = await createClient(transport).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(
      sandbox.wait({ intervalMs: 1, targetStatus: "terminal", timeoutMs: 100 }),
    ).rejects.toThrow(CWSandboxNotFoundError);
  });

  it("throws a typed transport error for terminal wait statuses", async () => {
    const sandbox = await createClient(createFakeTransport(["failed"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait({ intervalMs: 1, timeoutMs: 100 })).rejects.toThrow(
      CWSandboxTransportError,
    );
  });

  it("throws a structured transport error when completed before the default wait target", async () => {
    const sandbox = await createClient(createFakeTransport(["completed"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait({ intervalMs: 1, timeoutMs: 100 })).rejects.toMatchObject({
      operation: "Wait for sandbox",
      sandboxId: "sandbox-for-echo",
    });
  });

  it("throws a typed timeout error when wait exceeds the timeout", async () => {
    const sandbox = await createClient(createFakeTransport(["creating"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });

    await expect(sandbox.wait({ intervalMs: 1, timeoutMs: 1 })).rejects.toThrow(
      CWSandboxTimeoutError,
    );
  });

  it("throws typed validation errors for invalid wait and status options", async () => {
    const sandbox = await createClient().run(["echo", "hello"], { waitUntilRunning: false });

    await expect(sandbox.wait({ intervalMs: Number.NaN })).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(sandbox.getStatus({ timeoutMs: Number.NaN })).rejects.toThrow(
      CWSandboxValidationError,
    );
  });

  it("respects abort signals while waiting", async () => {
    const controller = new AbortController();
    const sandbox = await createClient(createFakeTransport(["creating"])).run(["echo", "hello"], {
      waitUntilRunning: false,
    });
    const reason = new Error("aborted");

    controller.abort(reason);

    await expect(
      sandbox.wait({ intervalMs: 1, signal: controller.signal, timeoutMs: 100 }),
    ).rejects.toBe(reason);
  });
});
