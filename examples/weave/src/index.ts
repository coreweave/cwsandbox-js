// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/wandb";
import * as weave from "weave";

interface SandboxHelloWorldResult {
  readonly command: readonly string[];
  readonly durationMs: number;
  readonly result: {
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
  };
  readonly sandbox: {
    readonly sandboxId: string;
    readonly tag: string;
  };
}

const weaveProject = process.env["WEAVE_PROJECT"] ?? "cwsandbox-js-weave-example";

await weave.init(weaveProject);

const runHelloWorldInSandbox = weave.op(
  async function runHelloWorldInSandbox(): Promise<SandboxHelloWorldResult> {
    const client = createSandboxClientFromEnv();
    const command = ["python", "-c", "print('hello world from cwsandbox')"];
    const tag = `weave-hello-${Date.now()}`;
    const startedAt = Date.now();

    return client.withSandbox(
      async (sandbox) => {
        const result = await sandbox.commands.run(command);

        return {
          command,
          durationMs: Date.now() - startedAt,
          result: {
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
          },
          sandbox: {
            sandboxId: sandbox.sandboxId,
            tag,
          },
        };
      },
      {
        tags: [tag],
      },
    );
  },
  { name: "runHelloWorldInSandbox" },
);

const result = await runHelloWorldInSandbox();

console.log("Weave project:", weaveProject);
console.log("Sandbox result:", result);
