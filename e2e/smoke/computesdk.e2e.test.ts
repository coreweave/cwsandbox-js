// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { CommandProcess, Sandbox } from "@coreweave/cwsandbox";
import { coreweave, type CoreWeaveSandbox } from "@coreweave/cwsandbox-computesdk";
import { describe, expect, it } from "vitest";

import { smokeConfig, uniqueSmokeTag, waitForHttpOk } from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const adapterSmokeTimeoutMs = 360_000;
const quotedDir = "/tmp/cwsandbox-js/quoted dir";
const quotedPath = `${quotedDir}/o'reilly.txt`;

describeWithCredentials("live ComputeSDK adapter smoke", { sequential: true }, () => {
  it(
    "creates a sandbox, exercises adapter mappings, and destroys it",
    async () => {
      const ownerTag = uniqueSmokeTag();
      const compute = coreweave({ ownerTag });
      console.log("creating ComputeSDK sandbox (1 cpu / 2Gi, lifetime 900s)...");
      const t0 = Date.now();
      const handle = await compute.sandbox.create({
        cpu: 1,
        image: "python:3.11",
        memoryMiB: 2048,
        maxLifetimeSeconds: 900,
        name: "adapter-smoke",
        services: [
          {
            endpoint: { auth: "open", kind: "https" },
            name: "http",
            port: 8000,
            visibility: "public",
          },
        ],
      });
      console.log(`created ${handle.sandboxId} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      let server: CommandProcess | undefined;

      try {
        const unary = await handle.runCommand("echo hello-from-coreweave && uname -r && nproc");
        console.log(
          `[unary] exit=${unary.exitCode} ${unary.durationMs}ms stdout=${JSON.stringify(unary.stdout)}`,
        );
        expect(unary.exitCode).toBe(0);
        expect(unary.stdout).toContain("hello-from-coreweave");

        const opts = await handle.runCommand('pwd && echo "V=$SMOKE_VAR"', {
          cwd: "/tmp",
          env: { SMOKE_VAR: "ok" },
        });
        console.log(`[opts]  exit=${opts.exitCode} stdout=${JSON.stringify(opts.stdout)}`);
        expect(opts.exitCode).toBe(0);
        expect(opts.stdout).toContain("/tmp");
        expect(opts.stdout).toContain("V=ok");

        server = await coreSandbox(handle).commands.start(["python", "-m", "http.server", "8000"]);
        const url = await handle.getUrl({ port: 8000 });
        console.log(`[url] ${url}`);
        expect(url.startsWith("https://")).toBe(true);
        const httpResponse = await waitForHttpOk(url);
        expect(httpResponse.status).toBe(200);

        const streamed = await handle.runCommand(
          'echo start; for i in 1 2 3; do sleep 3; echo "tick $i"; done; echo "to-stderr" >&2; exit 7',
          { timeout: 400_000 },
        );
        console.log(
          `[long] exit=${streamed.exitCode} ${streamed.durationMs}ms stdout=${JSON.stringify(streamed.stdout)} stderr=${JSON.stringify(streamed.stderr)}`,
        );
        expect(streamed.exitCode).toBe(7);
        expect(streamed.stdout).toContain("tick 3");
        expect(streamed.stderr).toContain("to-stderr");

        await handle.filesystem.writeFile(
          "/tmp/smoke/nested/hello.txt",
          "roundtrip ✓ with 'quotes' and $vars",
        );
        const content = await handle.filesystem.readFile("/tmp/smoke/nested/hello.txt");
        console.log(`[fs] readback=${JSON.stringify(content)}`);
        expect(content).toContain("roundtrip ✓");
        const entries = await handle.filesystem.readdir("/tmp/smoke/nested");
        console.log(`[fs] readdir=${JSON.stringify(entries)}`);
        expect(entries.some((entry) => entry.name === "hello.txt")).toBe(true);

        await handle.filesystem.mkdir(quotedDir);
        await handle.filesystem.writeFile(quotedPath, "quoted");
        expect(await handle.filesystem.exists(quotedPath)).toBe(true);
        const quotedEntries = await handle.filesystem.readdir(quotedDir);
        expect(quotedEntries.some((entry) => entry.name === "o'reilly.txt")).toBe(true);
        expect(await handle.filesystem.readFile(quotedPath)).toBe("quoted");
        await handle.filesystem.remove(quotedPath);
        expect(await handle.filesystem.exists(quotedPath)).toBe(false);

        const listed = await compute.sandbox.list();
        expect(listed.some((entry) => entry.sandboxId === handle.sandboxId)).toBe(true);

        const reconnected = await compute.sandbox.getById(handle.sandboxId);
        expect(reconnected?.sandboxId).toBe(handle.sandboxId);
        const echo = await reconnected?.runCommand("echo reconnected");
        expect(echo?.exitCode).toBe(0);
        expect(echo?.stdout).toContain("reconnected");

        const info = await handle.getInfo();
        console.log(`[info] status=${info.status} runner=${info.metadata?.["runnerId"] ?? ""}`);
        expect(info.status).toBe("running");
        expect(info.id).toBe(handle.sandboxId);
      } finally {
        const td = Date.now();
        try {
          await cancelStartedCommand(server);
        } finally {
          await handle.destroy();
          console.log(`destroyed in ${((Date.now() - td) / 1000).toFixed(1)}s`);
        }
      }
    },
    adapterSmokeTimeoutMs,
  );
});

if (!smokeConfig.hasCredentials) {
  console.log("Skipping live ComputeSDK adapter smoke: CWSANDBOX_API_KEY is not set.");
}

function coreSandbox(handle: { getInstance(): CoreWeaveSandbox }): Sandbox {
  return handle.getInstance().sandbox;
}

async function cancelStartedCommand(process: CommandProcess | undefined): Promise<void> {
  if (process === undefined) {
    return;
  }

  const stopped = process.wait();
  await process.cancel();
  await expect(stopped).rejects.toThrow("Streaming command cancelled.");
}
