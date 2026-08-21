// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxNotFoundError } from "@coreweave/cwsandbox";
import { cwsandboxTanStackProvider } from "@coreweave/cwsandbox-tanstack";
import { defineSandbox } from "@tanstack/ai-sandbox";
import { describe, expect, it } from "vitest";

import { smokeConfig, uniqueSmokeTag } from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const adapterSmokeTimeoutMs = 240_000;
const workspaceDir = "/tmp/cwsandbox-js-tanstack";
const textPath = `${workspaceDir}/hello.txt`;
const renamedPath = `${workspaceDir}/renamed.txt`;

describeWithCredentials("live TanStack adapter smoke", { sequential: true }, () => {
  it(
    "creates a sandbox, exercises adapter mappings, and destroys it",
    async () => {
      const tag = uniqueSmokeTag();
      const provider = cwsandboxTanStackProvider({
        createOptions: {
          environmentVariables: { FROM_CREATE: "yes" },
          maxLifetimeSeconds: 900,
          tags: [tag],
        },
      });
      const tanstackSandbox = defineSandbox({
        id: "cwsandbox-js-tanstack-smoke",
        provider,
      });
      console.log("creating TanStack sandbox...");
      const t0 = Date.now();
      const {
        destroy: destroySandbox,
        env,
        fs,
        id,
        process,
      } = await tanstackSandbox.ensure({
        runId: `run-${Date.now()}`,
        threadId: "cwsandbox-js-tanstack-smoke",
      });
      console.log(`created ${id} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      let destroyed = false;
      let cleanupError: unknown;

      try {
        await env.set({ FROM_HANDLE: "yes" });
        const exec = await process.exec(
          'pwd && printf "create=$FROM_CREATE handle=$FROM_HANDLE process=$FROM_PROCESS\\n"',
          {
            cwd: "/tmp",
            env: { FROM_PROCESS: "yes" },
          },
        );
        expect(exec.exitCode).toBe(0);
        expect(exec.stdout).toContain("/tmp");
        expect(exec.stdout).toContain("create=yes");
        expect(exec.stdout).toContain("handle=yes");
        expect(exec.stdout).toContain("process=yes");

        await fs.mkdir(workspaceDir);
        await fs.write(textPath, "hello from tanstack");
        expect(await fs.read(textPath)).toBe("hello from tanstack");
        expect(new TextDecoder().decode(await fs.readBytes(textPath))).toBe("hello from tanstack");
        expect(await fs.exists(textPath)).toBe(true);

        const listed = await fs.list(workspaceDir);
        expect(listed.map((entry) => entry.name)).toEqual(["hello.txt"]);
        expect(listed[0]?.type).toBe("file");

        await fs.rename(textPath, renamedPath);
        expect(await fs.exists(textPath)).toBe(false);
        expect(await fs.exists(renamedPath)).toBe(true);
        expect(await fs.read(renamedPath)).toBe("hello from tanstack");
        await fs.remove(renamedPath);
        expect(await fs.exists(renamedPath)).toBe(false);

        const spawned = await process.spawn("cat");
        const stdout = collectText(spawned.stdout);
        const stderr = collectText(spawned.stderr);
        await spawned.stdin.write("hello-from-spawn\n");
        await spawned.stdin.end();
        const [output, errorOutput, exitCode] = await Promise.all([stdout, stderr, spawned.wait()]);
        expect(exitCode).toBe(0);
        expect(output).toContain("hello-from-spawn");
        expect(errorOutput).toBe("");

        const resumed = await provider.resume({ id });
        expect(resumed?.id).toBe(id);
        const resumedExec = await resumed?.process.exec("echo resumed");
        expect(resumedExec?.exitCode).toBe(0);
        expect(resumedExec?.stdout).toContain("resumed");

        await destroySandbox();
        destroyed = true;
      } finally {
        if (!destroyed) {
          try {
            await destroySandbox();
          } catch (error) {
            if (!(error instanceof CWSandboxNotFoundError)) {
              cleanupError = error;
            }
          }
        }
      }
      if (cleanupError !== undefined) {
        throw cleanupError;
      }
    },
    adapterSmokeTimeoutMs,
  );
});

if (!smokeConfig.hasCredentials) {
  console.log("Skipping live TanStack adapter smoke: CWSANDBOX_API_KEY is not set.");
}

async function collectText(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
  }
  return text;
}
