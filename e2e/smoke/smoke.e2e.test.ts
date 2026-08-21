// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxExecutionError,
  CWSandboxTimeoutError,
  type Sandbox,
  type SandboxClient,
} from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPatternedPayload,
  dualHttpServerScript,
  expectBytesEqual,
  expectExposedPorts,
  expectRunning,
  expectTerminalStatus,
  httpsUrlToWss,
  LARGE_FILE_20_MIB,
  LARGE_FILE_40_MIB,
  largeFileTimeout20Ms,
  largeFileTimeout40Ms,
  STREAM_SMOKE_1_MIB,
  listAllIncludesSandbox,
  listIncludesSandbox,
  logCaughtError,
  logProcessResult,
  mountedBinaryContent,
  noInternetProbeScript,
  portProtocols,
  publicHttpsService,
  resourceProbeScript,
  runPython,
  smokeConfig,
  startOptionsForNoInternetNetwork,
  testTimeoutMs,
  uniqueSmokeTag,
  waitForHttpOk,
  waitForSandboxListPresence,
  waitForServiceUrl,
  waitForServiceUrls,
  waitForWebSocketEcho,
  websocketEchoScript,
  withDedicatedTaggedSandbox,
  withStartedSandbox,
} from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;

describeWithCredentials("live CWSandbox smoke", { sequential: true }, () => {
  let client: SandboxClient;
  let sandbox: Sandbox | undefined;

  beforeAll(async () => {
    client = createSandboxClientFromEnv();
    sandbox = await client.create();
    console.log(`Started sandbox: ${sandbox.sandboxId}`);
    console.log("Sandbox ready: running");
  }, testTimeoutMs);

  afterAll(async () => {
    if (sandbox === undefined) {
      return;
    }

    console.log(`Stopping sandbox: ${sandbox.sandboxId}`);
    await sandbox[Symbol.asyncDispose]();
    sandbox = undefined;
  }, testTimeoutMs);

  describe("shared sandbox basics", () => {
    it(
      "gets status and waits until running",
      async () => {
        expect.hasAssertions();

        await expectRunning(currentSandbox());
      },
      testTimeoutMs,
    );

    it(
      "inspects fresh sandbox metadata",
      async () => {
        const activeSandbox = currentSandbox();
        await activeSandbox.wait();
        const info = await activeSandbox.inspect();

        console.log("inspect metadata:", {
          exposedPorts: info.exposedPorts,
          runnerGroupId: info.runnerGroupId,
          runnerId: info.runnerId,
          serviceUrls: info.serviceUrls,
          startedAt: info.startedAt?.toISOString(),
          statusReason: info.statusReason,
        });

        expect(info).toMatchObject({
          runnerId: expect.stringMatching(/\S/),
          sandboxId: activeSandbox.sandboxId,
          startedAt: expect.any(Date),
          status: "running",
        });
        expect(info.startedAt?.getTime()).toBeGreaterThan(0);
        expect(activeSandbox.status).toBe("running");
        expect(activeSandbox.startedAt).toEqual(info.startedAt);
        expect(activeSandbox.runnerId).toBe(info.runnerId);
      },
      testTimeoutMs,
    );

    it(
      "gets fresh sandbox metadata by id",
      async () => {
        const activeSandbox = currentSandbox();
        const info = await client.get(activeSandbox.sandboxId);

        expect(info).toMatchObject({
          sandboxId: activeSandbox.sandboxId,
          status: "running",
        });
      },
      testTimeoutMs,
    );

    it(
      "reconnects to an existing sandbox by id",
      async () => {
        const reconnected = await client.fromId(currentSandbox().sandboxId);
        const result = await reconnected.commands.run(["echo", "hello from fromId"]);
        logProcessResult("fromId", result);

        await expect(reconnected.getStatus()).resolves.toBe("running");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("hello from fromId");
        expect(result.stderr).toBe("");
      },
      testTimeoutMs,
    );

    it(
      "lists the current sandbox",
      async () => {
        const isListed = await listIncludesSandbox(client, currentSandbox().sandboxId);

        expect(isListed).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      "listAll filters running sandboxes by status",
      async () => {
        const listed = await client.listAll({ status: "running" });

        expect(listed.some((entry) => entry.sandboxId === currentSandbox().sandboxId)).toBe(true);
      },
      testTimeoutMs,
    );
  });

  describe("command execution", () => {
    it(
      "runs commands through commands.run",
      async () => {
        const result = await runPython(currentSandbox(), "print('hello from commands.run')");
        logProcessResult("commands.run", result);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("hello from commands.run");
        expect(result.stderr).toBe("");
      },
      testTimeoutMs,
    );

    it(
      "executes commands through the exec alias",
      async () => {
        const result = await currentSandbox().exec([
          "python",
          "-c",
          "print('hello from exec alias')",
        ]);
        logProcessResult("exec", result);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("hello from exec alias");
        expect(result.stderr).toBe("");
      },
      testTimeoutMs,
    );

    it(
      "runs commands with a working directory",
      async () => {
        const path = "/tmp/cwsandbox-js-cwd.txt";
        const activeSandbox = currentSandbox();

        await activeSandbox.files.write(path, "hello from cwd");

        const pwdResult = await activeSandbox.commands.run(["pwd"], { cwd: "/tmp" });
        logProcessResult("cwd pwd", pwdResult);
        expect(pwdResult.exitCode).toBe(0);
        expect(pwdResult.stdout.trim()).toBe("/tmp");

        const catResult = await activeSandbox.commands.run(["cat", "cwsandbox-js-cwd.txt"], {
          cwd: "/tmp",
        });
        logProcessResult("cwd cat", catResult);
        expect(catResult.exitCode).toBe(0);
        expect(catResult.stdout).toBe("hello from cwd");
      },
      testTimeoutMs,
    );

    it(
      "returns non-zero command exit codes",
      async () => {
        const result = await runPython(currentSandbox(), "import sys; sys.exit(7)");
        logProcessResult("failing command", result);

        expect(result.exitCode).toBe(7);
      },
      testTimeoutMs,
    );

    it(
      "throws execution errors for checked non-zero command exits",
      async () => {
        await expect(
          currentSandbox().commands.run(["python", "-c", "import sys; sys.exit(7)"], {
            check: true,
          }),
        ).rejects.toBeInstanceOf(CWSandboxExecutionError);
      },
      testTimeoutMs,
    );

    it(
      "streams stdout and stderr through commands.start",
      async () => {
        const process = await currentSandbox().commands.start([
          "python",
          "-c",
          [
            "import sys",
            "print('stream-out-1')",
            "print('stream-err-1', file=sys.stderr)",
            "print('stream-out-2')",
          ].join("; "),
        ]);
        expect(["running", "starting"]).toContain(process.status);
        expect(process.poll()).toBeUndefined();
        const [stderr, stdout] = await Promise.all([
          collectStream(process.stderr),
          collectStream(process.stdout),
        ]);
        const result = await process.wait();

        expect(process.status).toBe("exited");
        expect(process.exitCode).toBe(0);
        expect(process.poll()).toBe(0);
        expect(stdout.join("")).toContain("stream-out-1");
        expect(stdout.join("")).toContain("stream-out-2");
        expect(stderr.join("")).toContain("stream-err-1");
        expect(result.exitCode).toBe(0);
        expect(result.ok).toBe(true);
        expect(result.failed).toBe(false);
        expect(result.stdout).toContain("stream-out-1");
        expect(result.stderr).toContain("stream-err-1");
        expect(new TextDecoder().decode(result.stdoutBytes)).toContain("stream-out-1");
        expect(new TextDecoder().decode(result.stderrBytes)).toContain("stream-err-1");
      },
      testTimeoutMs,
    );

    it(
      "returns non-zero streaming command exit codes",
      async () => {
        const process = await currentSandbox().commands.start([
          "python",
          "-c",
          "import sys; print('stream failing'); sys.exit(7)",
        ]);
        const stdout = collectStream(process.stdout);

        const result = await process.wait();
        expect(result.exitCode).toBe(7);
        expect(result.ok).toBe(false);
        expect(result.failed).toBe(true);
        expect(process.status).toBe("exited");
        expect(process.exitCode).toBe(7);
        await expect(stdout).resolves.toEqual(
          expect.arrayContaining([expect.stringContaining("stream failing")]),
        );
      },
      testTimeoutMs,
    );

    it(
      "accumulates streaming output without consuming streams",
      async () => {
        const process = await currentSandbox().commands.start([
          "python",
          "-c",
          "import sys; print('wait-out'); print('wait-err', file=sys.stderr)",
        ]);

        await expect(process.wait()).resolves.toMatchObject({
          exitCode: 0,
          stderr: expect.stringContaining("wait-err"),
          stdout: expect.stringContaining("wait-out"),
        });
      },
      testTimeoutMs,
    );

    it(
      "accumulates stderr when only stdout is consumed",
      async () => {
        const process = await currentSandbox().commands.start([
          "python",
          "-c",
          "import sys; print('stdout-only'); print('hidden-stderr', file=sys.stderr)",
        ]);
        const stdout = collectStream(process.stdout);
        const result = await process.wait();

        await expect(stdout).resolves.toEqual(
          expect.arrayContaining([expect.stringContaining("stdout-only")]),
        );
        expect(result.stderr).toContain("hidden-stderr");
      },
      testTimeoutMs,
    );

    it(
      "caps accumulated streaming output without stopping live streaming",
      async () => {
        const process = await currentSandbox().commands.start(
          ["python", "-c", "print('x' * 2048)"],
          { bufferedMaxKiB: 1 },
        );
        const stdout = await collectStream(process.stdout);
        const result = await process.wait();

        expect(stdout.join("").length).toBeGreaterThan(1024);
        expect(result.stdout.length).toBe(1024);
        expect(result.stdoutBytesProduced).toBe(2049);
        expect(result.stdoutTruncated).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      "writes stdin to a streaming command and closes EOF",
      async () => {
        const process = await currentSandbox().commands.start(["cat"], { stdin: true });
        const stdout = collectStream(process.stdout);

        await process.stdin.write("hello ");
        await process.stdin.writeln("stdin");
        await process.stdin.close();

        const result = await process.wait();
        const stdoutChunks = await stdout;

        expect(stdoutChunks.join("")).toContain("hello stdin\n");
        expect(process.stdin.closed).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("hello stdin\n");
      },
      testTimeoutMs,
    );

    it(
      "lets Python read multiple stdin lines before EOF",
      async () => {
        const process = await currentSandbox().commands.start(
          [
            "python",
            "-c",
            [
              "import sys",
              "first = sys.stdin.readline().strip()",
              "second = sys.stdin.readline().strip()",
              "print(f'{first}:{second}')",
            ].join("; "),
          ],
          { stdin: true },
        );

        await process.stdin.writeln("alpha");
        await process.stdin.writeln("beta");
        await process.stdin.close();

        const result = await process.wait();

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("alpha:beta");
      },
      testTimeoutMs,
    );

    it(
      "runs an interactive TTY shell session",
      async () => {
        const terminal = await currentSandbox().shell({
          cols: 80,
          command: ["/bin/sh"],
          rows: 24,
        });
        const output = collectStream(terminal.output);

        await terminal.stdin.writeln("echo tty-smoke");
        await terminal.stdin.writeln("exit 0");
        await terminal.stdin.close();

        const result = await terminal.wait();
        const text = new TextDecoder().decode(concatBytes(await output));

        expect(result.exitCode).toBe(0);
        expect(text).toContain("tty-smoke");
      },
      testTimeoutMs,
    );
  });

  describe("files", () => {
    it(
      "writes and reads files through the files namespace",
      async () => {
        const path = "/tmp/cwsandbox-js-smoke.txt";
        const activeSandbox = currentSandbox();

        await activeSandbox.files.write(path, "hello from files");
        const fileText = await activeSandbox.files.readText(path);
        console.log(`file readText: ${JSON.stringify(fileText)}`);
        expect(fileText).toBe("hello from files");

        const catResult = await activeSandbox.commands.run(["cat", path]);
        logProcessResult("cat", catResult);
        expect(catResult.exitCode).toBe(0);
        expect(catResult.stdout).toBe("hello from files");
      },
      testTimeoutMs,
    );

    it(
      "round-trips binary files through the files namespace",
      async () => {
        const content = new Uint8Array([0, 1, 2, 127, 128, 255]);
        const path = "/tmp/cwsandbox-js-smoke.bin";
        const activeSandbox = currentSandbox();

        await activeSandbox.files.write(path, content);
        const result = await activeSandbox.files.read(path);

        expect(Array.from(result)).toEqual(Array.from(content));
      },
      testTimeoutMs,
    );

    it(
      "round-trips batch files through the files namespace",
      async () => {
        const textPath = "/tmp/cwsandbox-js-batch.txt";
        const jsonPath = "/tmp/cwsandbox-js-batch.json";
        const binaryPath = "/tmp/cwsandbox-js-batch.bin";
        const binaryContent = new Uint8Array([3, 2, 1, 0]);
        const activeSandbox = currentSandbox();

        await activeSandbox.files.write([
          { content: "hello from batch", path: textPath },
          { content: JSON.stringify({ ok: true }), path: jsonPath },
          { content: binaryContent, path: binaryPath },
        ]);

        const textFiles = await activeSandbox.files.readText([textPath, jsonPath]);
        expect(textFiles[textPath]).toBe("hello from batch");
        expect(textFiles[jsonPath]).toBe(JSON.stringify({ ok: true }));

        const binaryFiles = await activeSandbox.files.read([binaryPath]);
        expect(Array.from(binaryFiles[binaryPath] ?? [])).toEqual(Array.from(binaryContent));
      },
      testTimeoutMs,
    );

    it(
      "round-trips multi-chunk writeStream and readStream (~1 MiB)",
      async () => {
        expect.hasAssertions();

        const path = "/tmp/cwsandbox-js-stream.bin";
        const chunkSize = 256 * 1024;
        const payload = createPatternedPayload(STREAM_SMOKE_1_MIB);
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < payload.byteLength; offset += chunkSize) {
          chunks.push(payload.subarray(offset, Math.min(offset + chunkSize, payload.byteLength)));
        }
        const activeSandbox = currentSandbox();

        await activeSandbox.files.writeStream(path, chunks);

        const parts: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of activeSandbox.files.readStream(path)) {
          parts.push(chunk);
          total += chunk.byteLength;
        }
        const received = new Uint8Array(total);
        let cursor = 0;
        for (const part of parts) {
          received.set(part, cursor);
          cursor += part.byteLength;
        }

        expectBytesEqual(received, payload);
      },
      testTimeoutMs,
    );
  });

  describe("dedicated keep-alive", () => {
    it(
      "times out an exec then reuses the sandbox",
      async () => {
        await withDedicatedTaggedSandbox(client, { waitUntilRunning: true }, async (sandbox) => {
          await expect(
            sandbox.commands.run(["sleep", "10"], { timeoutMs: 1000 }),
          ).rejects.toBeInstanceOf(CWSandboxTimeoutError);

          const result = await sandbox.commands.run(["echo", "still-alive"]);
          logProcessResult("timeout then reuse", result);

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("still-alive");
          expect(result.stderr).toBe("");
        });
      },
      testTimeoutMs,
    );

    it(
      "starts a sandbox with burstable resource requests and limits",
      async () => {
        const requests = { cpu: "500m", memory: "512Mi" };
        const limits = { cpu: "2", memory: "2Gi" };

        await withDedicatedTaggedSandbox(
          client,
          {
            create: (tag) =>
              client.create({
                resources: { limits, requests },
                tags: [tag],
              }),
            waitUntilRunning: true,
          },
          async (sandbox) => {
            expect(sandbox.resourceRequests).toEqual(requests);
            expect(sandbox.resourceLimits).toEqual(limits);

            const info = await sandbox.inspect();
            expect(info.resourceRequests).toEqual(requests);
            expect(info.resourceLimits).toEqual(limits);
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "resumes a follow log stream from a cursor",
      async () => {
        await withDedicatedTaggedSandbox(
          client,
          {
            create: (tag) =>
              client.run(
                [
                  "/bin/sh",
                  "-lc",
                  'i=0; while true; do printf "log-resume-%s\\n" "$i"; i=$((i+1)); sleep 0.2; done',
                ],
                { tags: [tag] },
              ),
            waitUntilRunning: true,
          },
          async (sandbox) => {
            const first = await sandbox.logs.streamEntries({ follow: true });
            const seen: string[] = [];

            try {
              for await (const entry of first) {
                seen.push(entry.line);
                if (seen.length >= 3) {
                  await first.close();
                }
              }
            } finally {
              await first.close();
            }

            const offset = first.offset;
            const sessionId = first.sessionId;
            expect(offset).toEqual(expect.stringMatching(/\S/));
            expect(sessionId).toEqual(expect.stringMatching(/\S/));
            if (offset === undefined || sessionId === undefined) {
              return;
            }

            const resumed = await sandbox.logs.stream({
              follow: true,
              resume: { offset, sessionId },
            });
            const continued: string[] = [];

            try {
              for await (const line of resumed) {
                continued.push(line);
                if (continued.length >= 2) {
                  await resumed.close();
                }
              }
            } finally {
              await resumed.close();
            }

            expect(seen.join("")).toContain("log-resume-");
            expect(continued.join("")).toContain("log-resume-");
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "cancels a streaming command then reuses the sandbox",
      async () => {
        await withDedicatedTaggedSandbox(client, { waitUntilRunning: true }, async (sandbox) => {
          const process = await sandbox.commands.start([
            "/bin/sh",
            "-lc",
            "while true; do echo tick; sleep 1; done",
          ]);
          const stdout: string[] = [];
          const collectTick = (async () => {
            for await (const chunk of process.stdout) {
              stdout.push(chunk);
              if (stdout.join("").includes("tick")) {
                return;
              }
            }
          })();

          await expect(collectTick).resolves.toBeUndefined();
          expect(stdout.join("")).toContain("tick");
          await process.cancel();
          await expect(process.wait()).rejects.toThrow("Streaming command cancelled.");

          const healthy = await sandbox.commands.run(["/bin/sh", "-lc", "echo healthy"]);
          logProcessResult("cancel then reuse", healthy);
          expect(healthy.exitCode).toBe(0);
          expect(healthy.stdout.trim()).toBe("healthy");
        });
      },
      testTimeoutMs,
    );
  });

  describe("large files", () => {
    it(
      "round-trips a 20 MiB file (Python known-good size) at 256Mi",
      async () => {
        expect.hasAssertions();

        const payload = createPatternedPayload(LARGE_FILE_20_MIB);
        const path = `/tmp/cwsandbox-js-large-write-${LARGE_FILE_20_MIB}.bin`;

        // Match Python integration defaults (20 MiB @ 256Mi). Above ~64 MiB the
        // single-session StreamExec path OOMs (exit 137) regardless of memory.
        await withStartedSandbox(
          client,
          {
            resources: { cpu: "500m", memory: "256Mi" },
            tags: [uniqueSmokeTag()],
          },
          async (sandbox) => {
            try {
              await sandbox.files.write(path, payload, { timeoutMs: largeFileTimeout20Ms });
              const readBack = await sandbox.files.read(path, { timeoutMs: largeFileTimeout20Ms });
              expectBytesEqual(readBack, payload);
            } catch (error) {
              logCaughtError("large file write 20 MiB", error);
              throw error;
            }
          },
        );
      },
      largeFileTimeout20Ms,
    );

    it(
      "round-trips a 40 MiB file via StreamExec fallback at 256Mi",
      async () => {
        expect.hasAssertions();

        const payload = createPatternedPayload(LARGE_FILE_40_MIB);
        const path = `/tmp/cwsandbox-js-large-write-${LARGE_FILE_40_MIB}.bin`;

        // Above default unary 32 MiB cap — exercises buffered StreamExec write/read.
        await withStartedSandbox(
          client,
          {
            resources: { cpu: "500m", memory: "256Mi" },
            tags: [uniqueSmokeTag()],
          },
          async (sandbox) => {
            try {
              await sandbox.files.write(path, payload, { timeoutMs: largeFileTimeout40Ms });
              const readBack = await sandbox.files.read(path, { timeoutMs: largeFileTimeout40Ms });
              expectBytesEqual(readBack, payload);
            } catch (error) {
              logCaughtError("large file write 40 MiB", error);
              throw error;
            }
          },
        );
      },
      largeFileTimeout40Ms,
    );
  });

  describe("logs", () => {
    it(
      "reads finite main-command logs with tailLines",
      async () => {
        await client.withSandbox(
          ["/bin/sh", "-lc", "printf 'one\\ntwo\\nthree\\n'; sleep infinity"],
          async (sandbox) => {
            const lines = await sandbox.logs.read({ tailLines: 2 });

            expect(lines.join("")).toBe("two\nthree\n");
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "does not emit logs for the default keep-alive command",
      async () => {
        const lines = await currentSandbox().logs.read({ tailLines: 10 });

        expect(lines).toEqual([]);
      },
      testTimeoutMs,
    );

    it(
      "does not include exec output in sandbox logs",
      async () => {
        const result = await currentSandbox().commands.run([
          "python",
          "-c",
          "print('exec-only-log-smoke')",
        ]);
        expect(result.stdout).toContain("exec-only-log-smoke");

        const lines = await currentSandbox().logs.read({ tailLines: 20 });

        expect(lines.join("")).not.toContain("exec-only-log-smoke");
      },
      testTimeoutMs,
    );

    it(
      "follows main-command logs and closes explicitly",
      async () => {
        await client.withSandbox(
          ["/bin/sh", "-lc", "sleep 1; printf 'READY\\n'; sleep infinity"],
          async (sandbox) => {
            const logs = await sandbox.logs.stream({ follow: true });
            const lines: string[] = [];

            try {
              for await (const line of logs) {
                lines.push(line);
                if (line.includes("READY")) {
                  await logs.close();
                }
              }
            } finally {
              await logs.close();
            }

            expect(lines.join("")).toContain("READY\n");
            expect(logs.closed).toBe(true);
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "streams structured log entries with cursor metadata",
      async () => {
        await client.withSandbox(
          ["/bin/sh", "-lc", "printf 'structured-log\\n'; sleep infinity"],
          async (sandbox) => {
            const stream = await sandbox.logs.streamEntries({ tailLines: 1, timestamps: true });

            try {
              const entries = await collectStream(stream);
              const entry = entries.at(0);

              expect(entry?.line).toContain("structured-log");
              expect(entry?.offset).not.toBe("");
            } finally {
              await stream.close();
            }
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "streams raw log chunks with bytes and text",
      async () => {
        await client.withSandbox(
          ["/bin/sh", "-lc", "printf 'raw-log\\n'; sleep infinity"],
          async (sandbox) => {
            const stream = await sandbox.logs.streamRaw({ tailLines: 1 });

            try {
              const chunks = await collectStream(stream);
              const chunk = chunks.at(0);

              expect(chunk?.data).toBeInstanceOf(Uint8Array);
              expect(chunk?.text).toContain("raw-log");
              expect(chunk?.offset).not.toBe("");
            } finally {
              await stream.close();
            }
          },
        );
      },
      testTimeoutMs,
    );
  });

  describe("start options", () => {
    it(
      "create does not reject annotations",
      async () => {
        await withStartedSandbox(
          client,
          {
            annotations: {
              purpose: "smoke-test",
              team: "platform",
            },
          },
          (sandbox) => {
            expect(sandbox.sandboxId).not.toBe("");
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "starts and lists a sandbox by tag",
      async () => {
        const tag = uniqueSmokeTag();

        await withStartedSandbox(
          client,
          {
            tags: [tag],
          },
          async (sandbox) => {
            const isListed = await listIncludesSandbox(client, sandbox.sandboxId, [tag]);

            expect(isListed).toBe(true);
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "lists matching sandboxes via listSandboxes",
      async () => {
        const tag = uniqueSmokeTag();
        const count = 3;
        const created: Sandbox[] = [];
        const listOptions = { pageSize: 1 as const, tags: [tag] };

        try {
          const batch = await Promise.all(
            Array.from({ length: count }, () => client.create({ tags: [tag] })),
          );
          created.push(...batch);

          // pageSize: 1 forces nextPageToken follow-up across the created batch.
          const fromItems = new Set<string>();
          for await (const sandbox of client.listSandboxes(listOptions)) {
            fromItems.add(sandbox.sandboxId);
          }

          const fromPages = new Set<string>();
          for await (const page of client.listSandboxes(listOptions).byPage()) {
            for (const sandbox of page) {
              fromPages.add(sandbox.sandboxId);
            }
          }

          const fromCollect = new Set(
            (await client.listSandboxes(listOptions).collect()).map((sandbox) => sandbox.sandboxId),
          );
          const fromListAll = new Set(
            (await client.listAll(listOptions)).map((sandbox) => sandbox.sandboxId),
          );

          for (const sandbox of created) {
            expect(fromItems.has(sandbox.sandboxId)).toBe(true);
            expect(fromPages.has(sandbox.sandboxId)).toBe(true);
            expect(fromCollect.has(sandbox.sandboxId)).toBe(true);
            expect(fromListAll.has(sandbox.sandboxId)).toBe(true);
          }
        } finally {
          await Promise.allSettled(created.map((sandbox) => sandbox.delete({ missingOk: true })));
        }
      },
      testTimeoutMs,
    );

    it(
      "starts a sandbox with environment variables",
      async () => {
        await withStartedSandbox(
          client,
          {
            environmentVariables: {
              CWSANDBOX_JS_SMOKE: "hello from env",
            },
          },
          async (sandbox) => {
            const result = await runPython(
              sandbox,
              "import os; print(os.environ['CWSANDBOX_JS_SMOKE'])",
            );
            logProcessResult("environment variables", result);

            expect(result.exitCode).toBe(0);
            expect(result.stdout.trim()).toBe("hello from env");
            expect(result.stderr).toBe("");
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "runs a mounted Python script",
      async () => {
        await withDedicatedTaggedSandbox(
          client,
          {
            create: (tag) =>
              client.create({
                mountedFiles: {
                  "/workspace/mounted.py": "print('hello from mounted file')",
                },
                tags: [tag],
              }),
            waitUntilRunning: true,
          },
          async (mountedSandbox) => {
            const result = await mountedSandbox.commands.run(["python", "/workspace/mounted.py"]);
            logProcessResult("mounted python", result);

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("hello from mounted file");
            expect(result.stderr).toBe("");
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "starts a sandbox with a mounted binary file",
      async () => {
        await withStartedSandbox(
          client,
          {
            mountedFiles: [
              {
                content: mountedBinaryContent,
                path: "/workspace/startup.bin",
              },
            ],
          },
          async (sandbox) => {
            const content = await sandbox.files.read("/workspace/startup.bin");

            expect(Array.from(content)).toEqual(Array.from(mountedBinaryContent));
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "starts a sandbox with resource requests",
      async () => {
        await withStartedSandbox(
          client,
          {
            resources: {
              cpu: "100m",
              memory: "128Mi",
            },
          },
          async (sandbox) => {
            expect(sandbox.resourceRequests).toEqual({ cpu: "100m", memory: "128Mi" });
            expect(sandbox.resourceLimits).toEqual({ cpu: "100m", memory: "128Mi" });

            const result = await runPython(sandbox, resourceProbeScript);
            logProcessResult("resources", result);

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("cpu.max=");
            expect(result.stdout).toContain("memory.max=");
          },
        );
      },
      testTimeoutMs,
    );

    it.each(portProtocols)(
      "accepts listen-only %s service without assigning a URL",
      async (protocol) => {
        await withStartedSandbox(
          client,
          {
            services: [
              {
                name: `port-${protocol.toLowerCase()}`,
                port: 8000,
                protocol: protocol.toLowerCase(),
              },
            ],
          },
          async (sandbox) => {
            console.log(`Started ${protocol} service sandbox: ${sandbox.sandboxId}`);
            const info = await sandbox.inspect();
            expect(info.serviceUrls ?? []).toEqual([]);
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "serves HTTP on two assigned public HTTPS URLs",
      async () => {
        await withStartedSandbox(
          client,
          {
            command: ["node", "/workspace/dual-http-server.js"],
            containerImage: "node:22",
            mountedFiles: {
              "/workspace/dual-http-server.js": dualHttpServerScript,
            },
            services: [publicHttpsService(8000, "http-a"), publicHttpsService(8001, "http-b")],
          },
          async (sandbox) => {
            const services = await waitForServiceUrls(sandbox, [8000, 8001]);
            const first = services.find((service) => service.port === 8000);
            const second = services.find((service) => service.port === 8001);
            if (first === undefined || second === undefined) {
              throw new Error("expected service URLs for ports 8000 and 8001");
            }
            expectExposedPorts(sandbox.exposedPorts, [8000, 8001]);

            const reattached = await client.fromId(sandbox.sandboxId);
            const refreshed = await reattached.inspect();
            const refreshedUrls = (refreshed.serviceUrls ?? []).map((service) => service.url);
            expect(refreshedUrls).toEqual(expect.arrayContaining([first.url, second.url]));

            const [firstResponse, secondResponse] = await Promise.all([
              waitForHttpOk(first.url),
              waitForHttpOk(second.url),
            ]);
            expect(await firstResponse.text()).toContain("ok:8000");
            expect(await secondResponse.text()).toContain("ok:8001");
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "echoes over the assigned public WebSocket URL",
      async () => {
        await withStartedSandbox(
          client,
          {
            command: ["node", "/workspace/websocket-echo.js"],
            containerImage: "node:22",
            mountedFiles: {
              "/workspace/websocket-echo.js": websocketEchoScript,
            },
            services: [publicHttpsService(8000, "ws")],
          },
          async (sandbox) => {
            const service = await waitForServiceUrl(sandbox, 8000);
            expectExposedPorts(sandbox.exposedPorts, [8000]);
            const echo = await waitForWebSocketEcho(httpsUrlToWss(service.url), "ping-from-smoke");
            expect(echo).toBe("ping-from-smoke");
          },
        );
      },
      testTimeoutMs,
    );
  });

  describe("network behavior", () => {
    it(
      "blocks outbound internet in a no-internet sandbox",
      async () => {
        await withStartedSandbox(client, startOptionsForNoInternetNetwork(), async (sandbox) => {
          console.log(`Started no-internet sandbox: ${sandbox.sandboxId}`);

          const result = await runPython(sandbox, noInternetProbeScript);
          logProcessResult("no-internet egress", result);

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("BLOCKED");
          expect(result.stdout).not.toContain("CONNECTED");
        });
      },
      testTimeoutMs,
    );
  });

  describe("stress coverage", () => {
    it(
      "waits for high-volume streaming output without consuming streams",
      async () => {
        const process = await currentSandbox().commands.start(
          [
            "python",
            "-c",
            [
              "import sys",
              "for _ in range(128):",
              "    sys.stdout.write('x' * 4096)",
              "    sys.stdout.flush()",
            ].join("\n"),
          ],
          { bufferedMaxKiB: 1 },
        );

        const result = await process.wait({ timeoutMs: 30_000 });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.length).toBe(1024);
        expect(result.stdoutBytesProduced).toBeGreaterThan(1024);
        expect(result.stdoutTruncated).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      "runs commands from a cwd containing spaces and quotes",
      async () => {
        const cwd = "/tmp/cwsandbox js quoted 'dir";
        const setupResult = await runPython(
          currentSandbox(),
          [
            "import os",
            `cwd = ${JSON.stringify(cwd)}`,
            "os.makedirs(cwd, exist_ok=True)",
            "open(os.path.join(cwd, 'message.txt'), 'w').write('quoted cwd ok')",
          ].join("; "),
        );
        expect(setupResult.exitCode).toBe(0);

        const pwdResult = await currentSandbox().commands.run(["pwd"], { cwd });
        expect(pwdResult.exitCode).toBe(0);
        expect(pwdResult.stdout.trim()).toBe(cwd);

        const catResult = await currentSandbox().commands.run(["cat", "message.txt"], { cwd });
        expect(catResult.exitCode).toBe(0);
        expect(catResult.stdout).toBe("quoted cwd ok");
      },
      testTimeoutMs,
    );

    it(
      "round-trips a larger batch of small files",
      async () => {
        const files = Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => [
            `/tmp/cwsandbox-js-stress-${index}.txt`,
            `stress-${index}`,
          ]),
        );

        await currentSandbox().files.write(files);
        const result = await currentSandbox().files.readText(Object.keys(files));

        expect(result).toEqual(files);
      },
      testTimeoutMs,
    );

    it(
      "finds a tagged sandbox through low-page-size pagination",
      async () => {
        const tag = uniqueSmokeTag();

        await withStartedSandbox(client, { tags: [tag] }, async (sandbox) => {
          const isListed = await listIncludesSandbox(client, sandbox.sandboxId, [tag], {
            pageSize: 1,
          });

          expect(isListed).toBe(true);
        });
      },
      testTimeoutMs,
    );
  });

  describe("cleanup", () => {
    it(
      "deletes a dedicated sandbox",
      async () => {
        let dedicatedSandbox: Sandbox | undefined;
        let deleted = false;

        try {
          dedicatedSandbox = await client.create();
          const sandboxId = dedicatedSandbox.sandboxId;
          console.log(`Started delete sandbox: ${sandboxId}`);

          await client.delete(sandboxId);
          await client.delete(sandboxId, { missingOk: true });
          deleted = true;
        } finally {
          if (dedicatedSandbox !== undefined && !deleted) {
            await dedicatedSandbox.stop({ missingOk: true });
          }
        }

        expect(deleted).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      "stop({ missingOk: true }) succeeds after delete",
      async () => {
        const sandbox = await client.create();
        console.log(`Started stop-missingOk sandbox: ${sandbox.sandboxId}`);

        await client.delete(sandbox.sandboxId);
        await expect(sandbox.stop({ missingOk: true })).resolves.toBeUndefined();
      },
      testTimeoutMs,
    );

    it(
      "lists a stopped sandbox only when showTerminated is true",
      async () => {
        const tag = uniqueSmokeTag();
        const dedicated = await client.create({ tags: [tag] });

        try {
          await dedicated.wait();
          await dedicated.stop();
          await expectTerminalStatus(dedicated);

          const hidden = await waitForSandboxListPresence(client, dedicated.sandboxId, [tag], {
            present: false,
          });
          expect(hidden).toBe(true);
          expect(await listAllIncludesSandbox(client, dedicated.sandboxId, [tag])).toBeUndefined();

          const shown = await waitForSandboxListPresence(client, dedicated.sandboxId, [tag], {
            present: true,
            showTerminated: true,
          });
          expect(shown).toBe(true);
        } finally {
          await dedicated.delete({ missingOk: true });
        }
      },
      testTimeoutMs,
    );

    it(
      "cleans up automatically with withSandbox",
      async () => {
        const tag = uniqueSmokeTag();
        let sandboxId: string | undefined;
        const result = await withStartedSandbox(client, { tags: [tag] }, (sandbox) => {
          sandboxId = sandbox.sandboxId;
          console.log(`Started withSandbox sandbox: ${sandbox.sandboxId}`);

          return runPython(sandbox, "print('hello from withSandbox')");
        });

        logProcessResult("withSandbox", result);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("hello from withSandbox");
        expect(result.stderr).toBe("");
        expect(sandboxId).toEqual(expect.stringMatching(/\S/));
        if (sandboxId === undefined) {
          return;
        }

        const hidden = await waitForSandboxListPresence(client, sandboxId, [tag], {
          present: false,
        });
        expect(hidden).toBe(true);
        const shown = await waitForSandboxListPresence(client, sandboxId, [tag], {
          present: true,
          showTerminated: true,
        });
        expect(shown).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      "stop() waits until the sandbox reaches a terminal status",
      async () => {
        expect.hasAssertions();

        await withDedicatedTaggedSandbox(
          client,
          { waitUntilRunning: true },
          async (dedicatedSandbox) => {
            await dedicatedSandbox.stop();
            await expectTerminalStatus(dedicatedSandbox);
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "second stop() is a no-op after terminal",
      async () => {
        await withDedicatedTaggedSandbox(
          client,
          { waitUntilRunning: true },
          async (dedicatedSandbox) => {
            await dedicatedSandbox.stop();
            await expectTerminalStatus(dedicatedSandbox);

            await expect(dedicatedSandbox.stop()).resolves.toBeUndefined();
            await expectTerminalStatus(dedicatedSandbox);
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "concurrent stop() calls share one in-flight operation",
      async () => {
        expect.hasAssertions();

        await withDedicatedTaggedSandbox(
          client,
          { waitUntilRunning: true },
          async (dedicatedSandbox) => {
            await Promise.all([dedicatedSandbox.stop(), dedicatedSandbox.stop()]);
            await expectTerminalStatus(dedicatedSandbox);
          },
        );
      },
      testTimeoutMs,
    );

    it(
      'wait({ targetStatus: "terminal" }) observes one-shot completion',
      async () => {
        await withDedicatedTaggedSandbox(
          client,
          {
            create: (tag) =>
              client.run(["python", "-c", "print('terminal-wait-smoke')"], {
                tags: [tag],
                waitUntilRunning: false,
              }),
          },
          async (dedicatedSandbox) => {
            await expect(dedicatedSandbox.wait({ targetStatus: "terminal" })).resolves.toBe(
              dedicatedSandbox,
            );
            await expectTerminalStatus(dedicatedSandbox);
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "exposes sandbox PID-1 exitCode after a completed one-shot",
      async () => {
        await withDedicatedTaggedSandbox(
          client,
          {
            create: (tag) =>
              client.run(["python", "-c", "print('exitcode-smoke')"], {
                tags: [tag],
                waitUntilRunning: false,
              }),
          },
          async (sandbox) => {
            await expect(sandbox.wait({ targetStatus: "completed" })).resolves.toBe(sandbox);
            expect(sandbox.status).toBe("completed");
            expect(sandbox.exitCode).toBe(0);

            const info = await sandbox.inspect();
            expect(info.exitCode).toBe(0);

            const got = await client.get(sandbox.sandboxId);
            expect(got.exitCode).toBe(0);
          },
        );
      },
      testTimeoutMs,
    );
  });

  function currentSandbox(): Sandbox {
    if (sandbox === undefined) {
      throw new Error("Sandbox has not been started.");
    }

    return sandbox;
  }
});

if (!smokeConfig.hasCredentials) {
  console.log("Skipping live CWSandbox smoke e2e: CWSANDBOX_API_KEY is not set.");
}

async function collectStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}
