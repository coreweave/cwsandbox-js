// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/wandb";
import { describe, expect, it } from "vitest";

import { logProcessResult, smokeConfig, testTimeoutMs, uniqueSmokeTag } from "./helpers.js";

const describeWithWandbCredentials = smokeConfig.hasWandbCredentials ? describe : describe.skip;
const describeWithWandbSecrets = smokeConfig.hasWandbSecretsSmoke ? describe : describe.skip;

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

describeWithWandbSecrets("live W&B sandbox secrets smoke", { sequential: true }, () => {
  it(
    "injects a referenced W&B team secret as an environment variable",
    async () => {
      const secret = smokeConfig.wandbSecretsSmoke;
      expect(secret).toBeDefined();
      if (secret === undefined) {
        return;
      }
      console.log("secret", secret);

      const client = createSandboxClientFromEnv();
      const result = await client.withSandbox(
        async (sandbox) => {
          const processResult = await sandbox.commands.run(["printenv", secret.envVar]);
          // Avoid echoing secret values into CI logs.
          console.log(`wandb secrets exit code: ${processResult.exitCode}`);
          console.log(
            `wandb secrets stdout: ${JSON.stringify(processResult.ok ? "<redacted>" : processResult.stdout)}`,
          );
          console.log(`wandb secrets stderr: ${JSON.stringify(processResult.stderr)}`);
          return processResult;
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
      expect(result.stdout.trim()).toBe(secret.expected);
      expect(result.stderr).toBe("");
    },
    testTimeoutMs,
  );
});

if (!smokeConfig.hasWandbCredentials) {
  console.log(
    "Skipping live W&B sandbox auth smoke: WANDB_API_KEY / W&B .netrc credential is not set.",
  );
}

if (!smokeConfig.hasWandbSecretsSmoke) {
  console.log(
    "Skipping live W&B sandbox secrets smoke: set CWSANDBOX_SMOKE_SECRET_NAME and CWSANDBOX_SMOKE_SECRET_EXPECTED with W&B auth.",
  );
}
