// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/wandb";
import { describe, expect, it } from "vitest";

import { logProcessResult, smokeConfig, testTimeoutMs, uniqueSmokeTag } from "./helpers.js";

const describeWithWandbCredentials = smokeConfig.hasWandbCredentials ? describe : describe.skip;

describeWithWandbCredentials("live W&B sandbox auth smoke", { sequential: true }, () => {
  it(
    "starts a sandbox through W&B auth and runs a command",
    async () => {
      const client = createSandboxClientFromEnv();
      const result = await client.withSandbox(
        async (sandbox) => {
          const processResult = await sandbox.commands.run([
            "python",
            "-c",
            "print('hello from wandb auth')",
          ]);
          logProcessResult("wandb auth", processResult);
          return processResult;
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
