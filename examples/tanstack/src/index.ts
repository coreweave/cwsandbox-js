// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

import { cwsandboxTanStackProvider } from "@coreweave/cwsandbox-tanstack";
import { defineSandbox, withSandbox } from "@tanstack/ai-sandbox";

interface TanStackExampleResult {
  readonly artifacts: {
    readonly files: readonly string[];
    readonly output: string;
    readonly source: string;
  };
  readonly capabilities: {
    readonly backgroundProcesses: boolean;
    readonly exec: boolean;
    readonly fs: boolean;
    readonly killableProcesses: boolean;
    readonly ports: boolean;
    readonly snapshots: boolean;
  };
  readonly middlewareReady: boolean;
  readonly test: {
    readonly command: string;
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
  };
  readonly sandbox: {
    readonly provider: string;
    readonly sandboxId: string;
    readonly tag: string;
  };
}

const tag = `tanstack-hello-${Date.now()}`;
const workspaceDir = "/workspace/tanstack-demo";
const appPath = `${workspaceDir}/app.py`;
const testPath = `${workspaceDir}/test_app.py`;
const outputPath = `${workspaceDir}/result.txt`;
const appSource = `def render_greeting(name: str) -> str:
    return f"hello {name} from cwsandbox tanstack adapter"


if __name__ == "__main__":
    print(render_greeting("workspace"))
`;
const testSource = `from app import render_greeting


message = render_greeting("workspace")
assert message == "hello workspace from cwsandbox tanstack adapter"
with open("result.txt", "w", encoding="utf-8") as output:
    output.write(message + "\\n")
print(message)
`;

export const tanstackSandbox = defineSandbox({
  id: "cwsandbox-js-tanstack-example",
  provider: cwsandboxTanStackProvider({
    createOptions: {
      tags: [tag],
    },
  }),
});

export const tanstackSandboxMiddleware = withSandbox(tanstackSandbox);

async function runExample(): Promise<TanStackExampleResult> {
  const {
    capabilities,
    destroy: destroySandbox,
    fs,
    id: sandboxId,
    process,
    provider,
  } = await tanstackSandbox.ensure({
    runId: `run-${Date.now()}`,
    threadId: "cwsandbox-js-tanstack-example",
  });
  const testCommand = "python test_app.py";

  try {
    await fs.mkdir(workspaceDir);
    await fs.write(appPath, appSource);
    await fs.write(testPath, testSource);

    const { exitCode, stderr, stdout } = await process.exec(testCommand, {
      cwd: workspaceDir,
    });
    const output = await fs.read(outputPath);
    const source = await fs.read(appPath);
    const files = await fs.list(workspaceDir);
    const {
      backgroundProcesses,
      exec,
      fs: hasFs,
      killableProcesses,
      ports,
      snapshots,
    } = capabilities;

    return {
      artifacts: {
        files: files.map((file) => file.name).sort(),
        output,
        source,
      },
      capabilities: {
        backgroundProcesses,
        exec,
        fs: hasFs,
        killableProcesses,
        ports,
        snapshots,
      },
      middlewareReady: tanstackSandboxMiddleware !== undefined,
      test: {
        command: testCommand,
        exitCode,
        stderr,
        stdout,
      },
      sandbox: {
        provider,
        sandboxId,
        tag,
      },
    };
  } finally {
    await destroySandbox();
  }
}

const result = await runExample();

console.log("TanStack sandbox result:", result);
