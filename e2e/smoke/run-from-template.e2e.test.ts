// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * Reduced live smoke for runFromTemplate / withSandboxFromTemplate.
 *
 * Uses a pre-created org template (CWSANDBOX_TEMPLATE_ID) that sets
 * TEMPLATE_SMOKE=from-template. This suite does not mint or delete that
 * template. It only creates sandboxes from it and cleans those sandboxes up.
 */

import type { Sandbox, SandboxClient } from "@coreweave/cwsandbox";
import {
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_KEEP_ALIVE_COMMAND,
  createSandboxClientFromEnv,
} from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import {
  expectTerminalStatus,
  logCaughtError,
  logProcessResult,
  smokeConfig,
  testTimeoutMs,
  uniqueSmokeTag,
} from "./helpers.js";

const describeWithTemplateSmoke = smokeConfig.hasTemplateSmoke ? describe : describe.skip;
const TEMPLATE_SMOKE_VALUE = "from-template";
const LOG_PREFIX = "[template-smoke]";

if (!smokeConfig.hasTemplateSmoke) {
  console.log(
    `${LOG_PREFIX} skip: set CWSANDBOX_TEMPLATE_ID to an org template with TEMPLATE_SMOKE=from-template (same org as CWSANDBOX_API_KEY). This smoke does not create or delete that template.`,
  );
} else {
  console.log(`${LOG_PREFIX} enabled`, {
    templateId: smokeConfig.templateSmoke?.templateId ?? null,
  });
}

describeWithTemplateSmoke("live runFromTemplate smoke", { sequential: true }, () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "inherits template env and cleans up the sandbox even if assertions fail",
    async () => {
      const templateId = requiredTemplateId();
      const startedAt = Date.now();
      logTemplateSmoke("runFromTemplate", { templateId });
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await client.runFromTemplate(templateId, {
          environmentVariables: {},
          tags: [uniqueSmokeTag()],
        });
        logTemplateSmoke("sandbox started", {
          elapsedMs: Date.now() - startedAt,
          sandboxId: sandbox.sandboxId,
        });
        const result = await sandbox.commands.run(["printenv", "TEMPLATE_SMOKE"]);
        logProcessResult("printenv TEMPLATE_SMOKE", result);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trimEnd()).toBe(TEMPLATE_SMOKE_VALUE);
      } catch (error) {
        logCaughtError(`${LOG_PREFIX} sandbox path`, error);
        throw error;
      } finally {
        logTemplateSmoke("delete sandbox", { sandboxId: sandbox?.sandboxId ?? null });
        await sandbox?.delete({ missingOk: true });
        logTemplateSmoke("done", { elapsedMs: Date.now() - startedAt, templateId });
      }
    },
    testTimeoutMs,
  );

  it(
    "replaces the template container when containerImage is set",
    async () => {
      const templateId = requiredTemplateId();
      const startedAt = Date.now();
      logTemplateSmoke("runFromTemplate replace", { templateId });
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await client.runFromTemplate(templateId, {
          command: [...DEFAULT_KEEP_ALIVE_COMMAND],
          containerImage: DEFAULT_CONTAINER_IMAGE,
          tags: [uniqueSmokeTag()],
        });
        logTemplateSmoke("sandbox started", {
          elapsedMs: Date.now() - startedAt,
          sandboxId: sandbox.sandboxId,
        });
        const result = await sandbox.commands.run(["printenv", "TEMPLATE_SMOKE"]);
        logProcessResult("printenv TEMPLATE_SMOKE after replace", result);
        expect(result.stdout.trim()).toBe("");
        expect(result.exitCode).not.toBe(0);
      } catch (error) {
        logCaughtError(`${LOG_PREFIX} replace path`, error);
        throw error;
      } finally {
        logTemplateSmoke("delete sandbox", { sandboxId: sandbox?.sandboxId ?? null });
        await sandbox?.delete({ missingOk: true });
        logTemplateSmoke("done", { elapsedMs: Date.now() - startedAt, templateId });
      }
    },
    testTimeoutMs,
  );

  it(
    "runs withSandboxFromTemplate and stops the sandbox after the callback",
    async () => {
      const templateId = requiredTemplateId();
      const startedAt = Date.now();
      logTemplateSmoke("withSandboxFromTemplate", { templateId });
      let sandboxId: string | undefined;
      try {
        const result = await client.withSandboxFromTemplate(
          templateId,
          async (sandbox) => {
            sandboxId = sandbox.sandboxId;
            logTemplateSmoke("sandbox started", {
              elapsedMs: Date.now() - startedAt,
              sandboxId,
            });
            const processResult = await sandbox.commands.run(["printenv", "TEMPLATE_SMOKE"]);
            logProcessResult("printenv TEMPLATE_SMOKE withSandboxFromTemplate", processResult);
            return processResult;
          },
          { environmentVariables: {}, tags: [uniqueSmokeTag()] },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trimEnd()).toBe(TEMPLATE_SMOKE_VALUE);
      } catch (error) {
        logCaughtError(`${LOG_PREFIX} withSandboxFromTemplate path`, error);
        throw error;
      } finally {
        if (sandboxId !== undefined) {
          const leftover = await client.fromId(sandboxId);
          await expectTerminalStatus(leftover);
          logTemplateSmoke("delete leftover after stop", { sandboxId });
          await leftover.delete({ missingOk: true });
        }
        logTemplateSmoke("done", { elapsedMs: Date.now() - startedAt, templateId });
      }
    },
    testTimeoutMs,
  );
});

function requiredTemplateId(): string {
  const templateId = smokeConfig.templateSmoke?.templateId;
  if (templateId === undefined) {
    throw new Error("CWSANDBOX_TEMPLATE_ID is required for template smoke.");
  }
  return templateId;
}

function logTemplateSmoke(step: string, detail?: Record<string, unknown>): void {
  if (detail === undefined) {
    console.log(`${LOG_PREFIX} ${step}`);
    return;
  }
  console.log(`${LOG_PREFIX} ${step}`, detail);
}
