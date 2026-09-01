// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxConfigurationError } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/wandb";
import { describe, expect, it } from "vitest";

import { smokeConfig, testTimeoutMs, uniqueSmokeTag } from "./helpers.js";

const describeWithSecretsConfig = smokeConfig.hasWandbSecretsSmoke ? describe : describe.skip;

describe("live W&B sandbox auth smoke", { sequential: true }, () => {
  it(
    "starts a sandbox through W&B auth and runs a command",
    async (ctx) => {
      const client = wandbClientOrSkip(ctx);
      if (client === undefined) {
        return;
      }

      const result = await client.withSandbox(
        async (sandbox) => {
          return sandbox.commands.run(["python", "-c", "print('hello from wandb auth')"]);
        },
        {
          tags: [uniqueSmokeTag()],
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello from wandb auth");
      expect(result.stderr).toBe("");
    },
    testTimeoutMs,
  );
});

describeWithSecretsConfig("live W&B sandbox secrets smoke", { sequential: true }, () => {
  it(
    "injects a referenced W&B team secret as an environment variable",
    async (ctx) => {
      const client = wandbClientOrSkip(ctx);
      if (client === undefined) {
        return;
      }

      const secret = smokeConfig.wandbSecretsSmoke;
      if (secret === undefined) {
        throw new Error(
          "CWSANDBOX_SMOKE_SECRET_NAME and CWSANDBOX_SMOKE_SECRET_EXPECTED are required.",
        );
      }

      const result = await client.withSandbox(
        async (sandbox) => {
          return sandbox.commands.run(["printenv", secret.envVar]);
        },
        {
          secrets: [
            {
              envVar: secret.envVar,
              name: secret.name,
              store: secret.store,
            },
          ],
          tags: [uniqueSmokeTag()],
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const matched = result.stdout.trim() === secret.expected;
      expect(
        matched,
        "injected secret env var did not match expected value (values redacted)",
      ).toBe(true);
    },
    testTimeoutMs,
  );

  it(
    "does not leak the secret to an uninjected sibling sandbox",
    async (ctx) => {
      const client = wandbClientOrSkip(ctx);
      if (client === undefined) {
        return;
      }

      const secret = smokeConfig.wandbSecretsSmoke;
      if (secret === undefined) {
        throw new Error(
          "CWSANDBOX_SMOKE_SECRET_NAME and CWSANDBOX_SMOKE_SECRET_EXPECTED are required.",
        );
      }

      const result = await client.withSandbox(
        async (sandbox) => {
          return sandbox.commands.run(["printenv", secret.envVar]);
        },
        {
          tags: [uniqueSmokeTag()],
        },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.length).toBe(0);
    },
    testTimeoutMs,
  );
});

function wandbClientOrSkip(ctx: { skip: (reason?: string) => void }) {
  try {
    return createSandboxClientFromEnv();
  } catch (error) {
    if (error instanceof CWSandboxConfigurationError) {
      ctx.skip(error.message);
      return undefined;
    }
    throw error;
  }
}
