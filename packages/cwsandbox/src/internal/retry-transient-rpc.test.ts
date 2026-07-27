// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it, vi } from "vitest";

import {
  CWSandboxAuthenticationError,
  CWSandboxNotFoundError,
  CWSandboxResourceExhaustedError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
} from "../errors.js";
import {
  classifyPollError,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_POLL_RETRY_HINTED_DELAY_MS,
  retryTransientRpc,
} from "./retry-transient-rpc.js";

describe("classifyPollError", () => {
  it("treats NotFound as fatal before other checks", () => {
    expect(classifyPollError(new CWSandboxNotFoundError("missing"))).toBe("fatal");
  });

  it("classifies transient transport failures as retryable", () => {
    expect(classifyPollError(new CWSandboxUnavailableError("blip"))).toBe("retryable");
    expect(classifyPollError(new CWSandboxTimeoutError("deadline"))).toBe("retryable");
    expect(classifyPollError(new CWSandboxResourceExhaustedError("busy"))).toBe("retryable");
  });

  it("classifies other errors as fatal", () => {
    expect(classifyPollError(new CWSandboxAuthenticationError("nope"))).toBe("fatal");
    expect(classifyPollError(new CWSandboxTransportError("other"))).toBe("fatal");
    expect(classifyPollError(new Error("plain"))).toBe("fatal");
  });
});

describe("retryTransientRpc", () => {
  it("returns the first successful attempt without sleeping", async () => {
    const sleep = vi.fn<(timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>>(
      async () => {},
    );
    const result = await retryTransientRpc(async () => "ok", {
      budgetMs: 30_000,
      operation: "test",
      sleep,
    });

    expect(result).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries Unavailable then succeeds", async () => {
    let calls = 0;
    const sleep = vi.fn<(timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>>(
      async () => {},
    );
    const result = await retryTransientRpc(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new CWSandboxUnavailableError("try again");
        }
        return "ok";
      },
      {
        budgetMs: 30_000,
        operation: "test",
        random: () => 0,
        sleep,
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep.mock.calls[0]?.[0]).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it("retries Timeout then succeeds", async () => {
    let calls = 0;
    const result = await retryTransientRpc(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new CWSandboxTimeoutError("deadline");
        }
        return "ok";
      },
      {
        budgetMs: 30_000,
        operation: "test",
        random: () => 0,
        sleep: async () => {},
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries ResourceExhausted then succeeds", async () => {
    let calls = 0;
    const result = await retryTransientRpc(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new CWSandboxResourceExhaustedError("busy");
        }
        return "ok";
      },
      {
        budgetMs: 30_000,
        operation: "test",
        random: () => 0,
        sleep: async () => {},
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not retry NotFound", async () => {
    const sleep = vi.fn<(timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>>(
      async () => {},
    );
    await expect(
      retryTransientRpc(
        async () => {
          throw new CWSandboxNotFoundError("missing");
        },
        { budgetMs: 30_000, operation: "test", sleep },
      ),
    ).rejects.toThrow(CWSandboxNotFoundError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rethrows the last error when the retry budget is exhausted", async () => {
    let nowMs = 0;
    const last = new CWSandboxUnavailableError("still down");
    await expect(
      retryTransientRpc(
        async () => {
          throw last;
        },
        {
          budgetMs: 1_000,
          now: () => nowMs,
          operation: "test",
          random: () => 0,
          sleep: async (timeoutMs) => {
            nowMs += timeoutMs;
          },
        },
      ),
    ).rejects.toBe(last);
  });

  it("honors retryDelayMs hints capped at 10s", async () => {
    let calls = 0;
    const sleep = vi.fn<(timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>>(
      async () => {},
    );
    await retryTransientRpc(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new CWSandboxUnavailableError("backed off", { retryDelayMs: 50_000 });
        }
        return "ok";
      },
      {
        budgetMs: 30_000,
        operation: "test",
        sleep,
      },
    );

    expect(sleep.mock.calls[0]?.[0]).toBe(MAX_POLL_RETRY_HINTED_DELAY_MS);
  });

  it("honors small retryDelayMs hints literally", async () => {
    let calls = 0;
    const sleep = vi.fn<(timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>>(
      async () => {},
    );
    await retryTransientRpc(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new CWSandboxUnavailableError("backed off", { retryDelayMs: 750 });
        }
        return "ok";
      },
      {
        budgetMs: 30_000,
        operation: "test",
        sleep,
      },
    );

    expect(sleep.mock.calls[0]?.[0]).toBe(750);
  });

  it("aborts during retry sleep", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted");
    controller.abort(reason);

    await expect(
      retryTransientRpc(
        async () => {
          throw new CWSandboxUnavailableError("blip");
        },
        {
          budgetMs: 30_000,
          operation: "test",
          random: () => 0,
          signal: controller.signal,
        },
      ),
    ).rejects.toBe(reason);
  });

  it("does not retry when budgetMs is zero", async () => {
    const sleep = vi.fn<(timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>>(
      async () => {},
    );
    await expect(
      retryTransientRpc(
        async () => {
          throw new CWSandboxUnavailableError("blip");
        },
        { budgetMs: 0, operation: "test", sleep },
      ),
    ).rejects.toThrow(CWSandboxUnavailableError);
    expect(sleep).not.toHaveBeenCalled();
  });
});
