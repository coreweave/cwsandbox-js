// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { randomUUID } from "node:crypto";

import {
  CWSANDBOX_FILE_NOT_FOUND,
  CWSandboxExecutionError,
  CWSandboxFileError,
  CWSandboxNotFoundError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  type CommandProcess,
  type Sandbox,
  type SandboxClient,
} from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  captureOp,
  combineCleanupError,
  createPatternedPayload,
  dualHttpServerScript,
  expectBytesEqual,
  expectExposedPorts,
  expectRunning,
  expectTerminalStatus,
  httpsUrlToWss,
  STREAM_SMOKE_1_MIB,
  logProcessResult,
  mountedBinaryContent,
  noInternetProbeScript,
  publicHttpsService,
  rejectAndNarrow,
  requireLogResumeCursor,
  runPython,
  smokeConfig,
  DNS_EGRESS_EXACT,
  DNS_EGRESS_UNGRANTED,
  DNS_EGRESS_WILD,
  DNS_EGRESS_WILD_HOST,
  dnsEgressSmokeTimeoutMs,
  httpsGetExitCode,
  shouldSkipDnsEgress,
  startOptionsForDnsNameEgress,
  startOptionsForNoInternetNetwork,
  testTimeoutMs,
  uniqueSmokeTag,
  waitForHttpOk,
  waitForServiceUrl,
  waitForServiceUrls,
  waitForWebSocketEcho,
  sortedSandboxIds,
  waitUntilFromIdTerminal,
  waitUntilListCondition,
  websocketEchoScript,
  withDedicatedTaggedSandbox,
  withStartedSandbox,
} from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const sharedTag = uniqueSmokeTag();
const reconnectPath = `/tmp/cwsandbox-js-reconnect-${sharedTag}.txt`;
const missingFilePath = `/tmp/cwsandbox-js-missing-${sharedTag}.txt`;

describeWithCredentials("live CWSandbox smoke", { sequential: true }, () => {
  let client: SandboxClient;
  let sandbox: Sandbox | undefined;

  beforeAll(async () => {
    client = createSandboxClientFromEnv();
    sandbox = await client.create({ tags: [sharedTag] });
    console.log(`Started sandbox: ${sandbox.sandboxId}`);
    console.log("Sandbox ready: running");
  }, testTimeoutMs);

  afterAll(async () => {
    const sharedId = sandbox?.sandboxId;
    const primary = await captureOp(async () => {
      if (sandbox === undefined) {
        return;
      }
      console.log(`Stopping sandbox: ${sandbox.sandboxId}`);
      await sandbox[Symbol.asyncDispose]();
      sandbox = undefined;
      if (sharedId !== undefined) {
        await waitUntilListCondition(client, {
          expectedSandboxIds: [],
          listOptions: { tags: [sharedTag] },
          pollTimeoutMs: 30_000,
        });
      }
    });
    const cleanup = await captureOp(async () => {
      if (sharedId !== undefined) {
        await client.delete(sharedId, { missingOk: true });
      }
    });
    combineCleanupError(primary, cleanup);
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
        const activeSandbox = currentSandbox();
        await activeSandbox.files.write(reconnectPath, "hello from reconnect");

        const fresh = await createSandboxClientFromEnv().fromId(activeSandbox.sandboxId);

        await expect(fresh.getStatus()).resolves.toBe("running");
        const execResult = await fresh.exec(["cat", reconnectPath]);
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toBe("hello from reconnect");
        expect(await fresh.files.readText(reconnectPath)).toBe("hello from reconnect");
      },
      testTimeoutMs,
    );

    it(
      "lists the current sandbox",
      async () => {
        const ids = await waitUntilListCondition(client, {
          expectedSandboxIds: [currentSandbox().sandboxId],
          listOptions: { tags: [sharedTag] },
          pollTimeoutMs: 30_000,
        });
        expect(ids).toEqual(sortedSandboxIds([currentSandbox().sandboxId]));
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
        expect(pwdResult.exitCode).toBe(0);
        expect(pwdResult.stdout.trim()).toBe("/tmp");

        const catResult = await activeSandbox.commands.run(["cat", "cwsandbox-js-cwd.txt"], {
          cwd: "/tmp",
        });
        expect(catResult.exitCode).toBe(0);
        expect(catResult.stdout).toBe("hello from cwd");
      },
      testTimeoutMs,
    );

    it(
      "returns non-zero command exit codes",
      async () => {
        const result = await runPython(currentSandbox(), "import sys; sys.exit(7)");
        expect(result.exitCode).toBe(7);
      },
      testTimeoutMs,
    );

    it(
      "throws execution errors for checked non-zero command exits",
      async () => {
        const error = await rejectAndNarrow(
          () =>
            currentSandbox().commands.run(["python", "-c", "import sys; sys.exit(7)"], {
              check: true,
            }),
          (value): value is CWSandboxExecutionError => value instanceof CWSandboxExecutionError,
        );
        expect(error.code).toBe("execution_error");
        if (error.result === undefined) {
          throw new Error("CWSandboxExecutionError.result is required");
        }
        expect(error.result.exitCode).toBe(7);
      },
      testTimeoutMs,
    );

    it(
      "times out a remote run and then reuses the sandbox",
      async () => {
        const error = await rejectAndNarrow(
          () => currentSandbox().commands.run(["sleep", "10"], { timeoutMs: 1000 }),
          (value): value is CWSandboxTimeoutError => value instanceof CWSandboxTimeoutError,
        );
        expect(error.code).toBe("timeout_error");
        const result = await currentSandbox().exec(["true"]);
        expect(result.exitCode).toBe(0);
      },
      testTimeoutMs,
    );

    it(
      "streams stdout and stderr through commands.start",
      async () => {
        await withProcessCleanup(
          () =>
            currentSandbox().commands.start([
              "python",
              "-c",
              [
                "import sys",
                "print('stream-out-1')",
                "print('stream-err-1', file=sys.stderr)",
                "print('stream-out-2')",
              ].join("; "),
            ]),
          async (process) => {
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
        );
      },
      testTimeoutMs,
    );

    it(
      "returns non-zero streaming command exit codes",
      async () => {
        await withProcessCleanup(
          () =>
            currentSandbox().commands.start([
              "python",
              "-c",
              "import sys; print('stream failing'); sys.exit(7)",
            ]),
          async (process) => {
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
        );
      },
      testTimeoutMs,
    );

    it(
      "accumulates streaming output without consuming streams",
      async () => {
        await withProcessCleanup(
          () =>
            currentSandbox().commands.start([
              "python",
              "-c",
              "import sys; print('wait-out'); print('wait-err', file=sys.stderr)",
            ]),
          async (process) => {
            await expect(process.wait()).resolves.toMatchObject({
              exitCode: 0,
              stderr: expect.stringContaining("wait-err"),
              stdout: expect.stringContaining("wait-out"),
            });
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "accumulates stderr when only stdout is consumed",
      async () => {
        await withProcessCleanup(
          () =>
            currentSandbox().commands.start([
              "python",
              "-c",
              "import sys; print('stdout-only'); print('hidden-stderr', file=sys.stderr)",
            ]),
          async (process) => {
            const stdout = collectStream(process.stdout);
            const result = await process.wait();
            await expect(stdout).resolves.toEqual(
              expect.arrayContaining([expect.stringContaining("stdout-only")]),
            );
            expect(result.stderr).toContain("hidden-stderr");
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "caps accumulated streaming output without stopping live streaming",
      async () => {
        await withProcessCleanup(
          () =>
            currentSandbox().commands.start(["python", "-c", "print('x' * 2048)"], {
              bufferedMaxKiB: 1,
            }),
          async (process) => {
            const stdout = await collectStream(process.stdout);
            const result = await process.wait();
            expect(stdout.join("").length).toBeGreaterThan(1024);
            expect(result.stdout.length).toBe(1024);
            expect(result.stdoutBytesProduced).toBe(2049);
            expect(result.stdoutTruncated).toBe(true);
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "writes stdin to a streaming command and closes EOF",
      async () => {
        await withProcessCleanup(
          () => currentSandbox().commands.start(["cat"], { stdin: true }),
          async (process) => {
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
        );
      },
      testTimeoutMs,
    );

    it(
      "lets Python read multiple stdin lines before EOF",
      async () => {
        await withProcessCleanup(
          () =>
            currentSandbox().commands.start(
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
            ),
          async (process) => {
            await process.stdin.writeln("alpha");
            await process.stdin.writeln("beta");
            await process.stdin.close();
            const result = await process.wait();
            expect(result.exitCode).toBe(0);
            expect(result.stdout.trim()).toBe("alpha:beta");
          },
        );
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
        const primary = await captureOp(async () => {
          const output = collectStream(terminal.output);
          await terminal.stdin.writeln("echo tty-smoke");
          await terminal.stdin.writeln("exit 0");
          await terminal.stdin.close();
          const result = await terminal.wait();
          const text = new TextDecoder().decode(concatBytes(await output));
          expect(result.exitCode).toBe(0);
          expect(text).toContain("tty-smoke");
        });
        const cleanup = await captureOp(async () => {
          if (primary.failed) {
            await terminal.cancel();
          }
        });
        combineCleanupError(primary, cleanup);
      },
      testTimeoutMs,
    );

    it(
      "times out a local process.wait then finishes the same process",
      async () => {
        await withProcessCleanup(
          () =>
            currentSandbox().commands.start([
              "python",
              "-c",
              "import time; time.sleep(2); print('local-wait-done', flush=True)",
            ]),
          async (process) => {
            const error = await rejectAndNarrow(
              () => process.wait({ timeoutMs: 200 }),
              (value): value is CWSandboxTimeoutError => value instanceof CWSandboxTimeoutError,
            );
            expect(error.code).toBe("timeout_error");
            const result = await process.wait();
            expect(result.exitCode).toBe(0);
            expect(result.stdout.trim()).toBe("local-wait-done");
            const reuse = await currentSandbox().exec(["true"]);
            expect(reuse.exitCode).toBe(0);
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "cancels a streaming command and reuses the sandbox",
      async () => {
        const process = await currentSandbox().commands.start([
          "python",
          "-c",
          "import time; print('tick', flush=True); time.sleep(30)",
        ]);
        let cancelled = false;
        const primary = await captureOp(async () => {
          let sawTick = false;
          for await (const chunk of process.stdout) {
            if (chunk.includes("tick")) {
              sawTick = true;
              break;
            }
          }
          expect(sawTick).toBe(true);
          await process.cancel();
          cancelled = true;
          const error = await rejectAndNarrow(
            () => process.wait(),
            (value): value is CWSandboxTransportError => value instanceof CWSandboxTransportError,
          );
          expect(error.code).toBe("transport_error");
          expect(error.message).toBe("Streaming command cancelled.");
          expect(process.status).toBe("cancelled");
          const reuse = await currentSandbox().exec(["true"]);
          expect(reuse.exitCode).toBe(0);
        });
        const cleanup = await captureOp(async () => {
          if (!cancelled) {
            await process.cancel();
          }
        });
        combineCleanupError(primary, cleanup);
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
        expect(fileText).toBe("hello from files");

        const catResult = await activeSandbox.commands.run(["cat", path]);
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
      "throws a typed error for a missing file",
      async () => {
        const error = await rejectAndNarrow(
          () => currentSandbox().files.read(missingFilePath),
          (value): value is CWSandboxFileError => value instanceof CWSandboxFileError,
        );
        expect(error.code).toBe("transport_error");
        expect(error.reason).toBe(CWSANDBOX_FILE_NOT_FOUND);
        expect(error.filepath).toBe(missingFilePath);
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
          { tags: [uniqueSmokeTag()] },
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
            const primary = await captureOp(async () => {
              const lines: string[] = [];
              for await (const line of logs) {
                lines.push(line);
                if (line.includes("READY")) {
                  await logs.close();
                }
              }
              expect(lines.join("")).toContain("READY\n");
              expect(logs.closed).toBe(true);
            });
            const cleanup = await captureOp(async () => {
              await logs.close();
            });
            combineCleanupError(primary, cleanup);
          },
          { tags: [uniqueSmokeTag()] },
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
            const primary = await captureOp(async () => {
              const entries = await collectStream(stream);
              const entry = entries.at(0);
              expect(entry?.line).toContain("structured-log");
              expect(entry?.offset).not.toBe("");
            });
            const cleanup = await captureOp(async () => {
              await stream.close();
            });
            combineCleanupError(primary, cleanup);
          },
          { tags: [uniqueSmokeTag()] },
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
            const primary = await captureOp(async () => {
              const chunks = await collectStream(stream);
              const chunk = chunks.at(0);
              expect(chunk?.data).toBeInstanceOf(Uint8Array);
              expect(chunk?.text).toContain("raw-log");
              expect(chunk?.offset).not.toBe("");
            });
            const cleanup = await captureOp(async () => {
              await stream.close();
            });
            combineCleanupError(primary, cleanup);
          },
          { tags: [uniqueSmokeTag()] },
        );
      },
      testTimeoutMs,
    );

    it(
      "resumes a follow stream from the captured cursor in order",
      async () => {
        const producer = [
          "import time, pathlib",
          "p = pathlib.Path('/tmp/cwsandbox-js-log-go')",
          "while not p.exists():",
          "    time.sleep(0.05)",
          "for i in range(1, 21):",
          "    print(f'line-{i:04d}', flush=True)",
          "    time.sleep(0.1)",
          "time.sleep(60)",
        ].join("\n");

        await client.withSandbox(
          ["python", "-c", producer],
          async (sandbox) => {
            const first = await sandbox.logs.streamRaw({ follow: true });
            const firstChunks: Uint8Array[] = [];
            let resume: ReturnType<typeof requireLogResumeCursor> | undefined;
            const firstPrimary = await captureOp(async () => {
              await sandbox.files.write("/tmp/cwsandbox-js-log-go", "go");
              let lastChunk: { offset?: string; sessionId?: string } | undefined;
              for await (const chunk of first) {
                lastChunk = chunk;
                firstChunks.push(chunk.data);
                if (numberedLogLines(concatBytes(firstChunks)).length >= 5) {
                  break;
                }
              }
              if (lastChunk === undefined) {
                throw new Error("expected at least one raw log chunk before resume");
              }
              resume = requireLogResumeCursor({
                ...(lastChunk.offset === undefined ? {} : { offset: lastChunk.offset }),
                ...(lastChunk.sessionId === undefined ? {} : { sessionId: lastChunk.sessionId }),
              });
            });
            const firstCleanup = await captureOp(async () => {
              await first.close();
            });
            combineCleanupError(firstPrimary, firstCleanup);

            if (resume === undefined) {
              throw new Error("log resume cursor is required after the first follow stream");
            }
            const second = await sandbox.logs.streamRaw({ follow: true, resume });
            const secondPrimary = await captureOp(async () => {
              const secondChunks: Uint8Array[] = [];
              for await (const chunk of second) {
                secondChunks.push(chunk.data);
                if (numberedLogLines(concatBytes([...firstChunks, ...secondChunks])).length >= 12) {
                  break;
                }
              }
              const combined = numberedLogLines(concatBytes([...firstChunks, ...secondChunks]));
              const expected = Array.from(
                { length: combined.length },
                (_, index) => `line-${String(index + 1).padStart(4, "0")}`,
              );
              expect(combined).toEqual(expected);
            });
            const secondCleanup = await captureOp(async () => {
              await second.close();
            });
            combineCleanupError(secondPrimary, secondCleanup);
          },
          { tags: [uniqueSmokeTag()] },
        );
      },
      testTimeoutMs,
    );
  });

  describe("start options", () => {
    it(
      "starts a sandbox with environment variables",
      async () => {
        await withStartedSandbox(
          client,
          {
            environmentVariables: {
              CWSANDBOX_JS_SMOKE: "hello from env",
            },
            tags: [uniqueSmokeTag()],
          },
          async (sandbox) => {
            const result = await runPython(
              sandbox,
              "import os; print(os.environ['CWSANDBOX_JS_SMOKE'])",
            );
            expect(result.exitCode).toBe(0);
            expect(result.stdout.trim()).toBe("hello from env");
            expect(result.stderr).toBe("");
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
            tags: [uniqueSmokeTag()],
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
            tags: [uniqueSmokeTag()],
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

    it(
      "starts a configured-options sandbox and uses it as the tag-negative control",
      async () => {
        const configuredTag = uniqueSmokeTag();

        await withStartedSandbox(
          client,
          {
            mountedFiles: {
              "/workspace/mounted.txt": "hello from mounted text",
              "/workspace/startup.bin": mountedBinaryContent,
            },
            resources: { cpu: "100m", memory: "128Mi" },
            tags: [configuredTag],
          },
          async (sandbox) => {
            const text = await sandbox.exec(["cat", "/workspace/mounted.txt"]);
            expect(text.exitCode).toBe(0);
            expect(text.stdout).toBe("hello from mounted text");
            expectBytesEqual(
              await sandbox.files.read("/workspace/startup.bin"),
              mountedBinaryContent,
            );

            const expectedResources = { cpu: "100m", memory: "128Mi" };
            expect(sandbox.resourceRequests).toEqual(expectedResources);
            expect(sandbox.resourceLimits).toEqual(expectedResources);
            const inspected = await sandbox.inspect();
            expect(inspected.resourceRequests).toEqual(expectedResources);
            expect(inspected.resourceLimits).toEqual(expectedResources);

            await waitUntilListCondition(client, {
              expectedSandboxIds: [sandbox.sandboxId],
              listOptions: { tags: [configuredTag] },
              pollTimeoutMs: 30_000,
            });
            await waitUntilListCondition(client, {
              expectedSandboxIds: [currentSandbox().sandboxId],
              listOptions: { tags: [sharedTag] },
              pollTimeoutMs: 30_000,
            });
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "reconnects to a stopped sandbox and filters it from the running shared-tag list",
      async () => {
        const stoppedTag = uniqueSmokeTag();
        const dedicated = await client.create({ tags: [stoppedTag, sharedTag] });

        try {
          await dedicated.wait();
          await dedicated.stop();
          const recovered = await createSandboxClientFromEnv().fromId(dedicated.sandboxId);
          await expectTerminalStatus(recovered);

          const terminated = await waitUntilListCondition(client, {
            expectedSandboxIds: [currentSandbox().sandboxId, dedicated.sandboxId],
            listOptions: { showTerminated: true, tags: [sharedTag] },
            pollTimeoutMs: 30_000,
          });
          expect(terminated).toEqual(
            sortedSandboxIds([currentSandbox().sandboxId, dedicated.sandboxId]),
          );
          const running = await waitUntilListCondition(client, {
            expectedSandboxIds: [currentSandbox().sandboxId],
            listOptions: { showTerminated: true, status: "running", tags: [sharedTag] },
            pollTimeoutMs: 30_000,
          });
          expect(running).toEqual(sortedSandboxIds([currentSandbox().sandboxId]));
        } finally {
          await dedicated.delete({ missingOk: true });
        }
      },
      testTimeoutMs,
    );
  });

  describe("network behavior", () => {
    it(
      "blocks outbound internet in a no-internet sandbox",
      async () => {
        await withStartedSandbox(
          client,
          { ...startOptionsForNoInternetNetwork(), tags: [uniqueSmokeTag()] },
          async (sandbox) => {
            const result = await runPython(sandbox, noInternetProbeScript);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("BLOCKED");
            expect(result.stdout).not.toContain("CONNECTED");
          },
        );
      },
      testTimeoutMs,
    );

    it(
      "grants HTTPS to declared dns names and misses the rest",
      async (ctx) => {
        let admitted: Sandbox | undefined;
        try {
          admitted = await client.create({
            ...startOptionsForDnsNameEgress(),
            tags: [uniqueSmokeTag()],
          });
          await admitted.wait();
        } catch (error) {
          if (shouldSkipDnsEgress(error)) {
            ctx.skip(`fleet cannot admit DNS-name egress: ${String(error)}`);
            return;
          }
          throw error;
        }

        try {
          const granted = [DNS_EGRESS_EXACT, DNS_EGRESS_WILD];
          expect(admitted.dnsEgressNames).toEqual(expect.arrayContaining(granted));
          expect((await admitted.inspect()).dnsEgressNames).toEqual(
            expect.arrayContaining(granted),
          );
          expect(await httpsGetExitCode(admitted, `https://${DNS_EGRESS_EXACT}`, 20)).toBe(0);
          expect(await httpsGetExitCode(admitted, `https://${DNS_EGRESS_WILD_HOST}`, 20)).toBe(0);
          expect(await httpsGetExitCode(admitted, `https://${DNS_EGRESS_UNGRANTED}`, 8)).not.toBe(
            0,
          );
        } finally {
          await admitted.delete({ missingOk: true });
        }
      },
      dnsEgressSmokeTimeoutMs,
    );
  });

  describe("cleanup", () => {
    it(
      "deletes a dedicated sandbox",
      async () => {
        let dedicatedSandbox: Sandbox | undefined;
        let deleted = false;

        try {
          dedicatedSandbox = await client.create({ tags: [uniqueSmokeTag()] });
          const sandboxId = dedicatedSandbox.sandboxId;
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
        const sandbox = await client.create({ tags: [uniqueSmokeTag()] });
        await client.delete(sandbox.sandboxId);
        await expect(sandbox.stop({ missingOk: true })).resolves.toBeUndefined();
      },
      testTimeoutMs,
    );

    it(
      "cleans up automatically with withSandbox",
      async () => {
        const tag = uniqueSmokeTag();
        const result = await withStartedSandbox(client, { tags: [tag] }, (sandbox) => {
          return runPython(sandbox, "print('hello from withSandbox')");
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("hello from withSandbox");
        expect(result.stderr).toBe("");
        await waitUntilListCondition(client, {
          expectedSandboxIds: [],
          listOptions: { tags: [tag] },
          pollTimeoutMs: 30_000,
        });
      },
      testTimeoutMs,
    );

    it(
      "preserves a withSandbox callback error and still cleans up",
      async () => {
        const tag = uniqueSmokeTag();
        const callbackError = new Error("withSandbox callback failed");
        let sandboxId: string | undefined;
        const primary = await captureOp(async () => {
          await client.withSandbox(
            async (sandbox) => {
              sandboxId = sandbox.sandboxId;
              throw callbackError;
            },
            { tags: [tag] },
          );
        });
        expect(primary).toEqual({ error: callbackError, failed: true });
        const observed = await captureOp(async () => {
          await waitUntilListCondition(client, {
            expectedSandboxIds: [],
            listOptions: { tags: [tag] },
            pollTimeoutMs: 30_000,
          });
        });
        if (!observed.failed) {
          return;
        }
        const cleanupErrors: unknown[] = [observed.error];
        if (sandboxId !== undefined) {
          const leftoverId = sandboxId;
          const fallback = await captureOp(async () => {
            await client.delete(leftoverId, { missingOk: true });
          });
          if (fallback.failed) {
            cleanupErrors.push(fallback.error);
          }
        }
        throw new AggregateError([callbackError, ...cleanupErrors]);
      },
      testTimeoutMs,
    );

    it(
      "hides a deleted sandbox from the default list",
      async () => {
        const tag = uniqueSmokeTag();
        const dedicated = await client.create({ tags: [tag] });
        await dedicated.wait();
        const sandboxId = dedicated.sandboxId;
        await client.delete(sandboxId);
        const remaining = await waitUntilListCondition(client, {
          expectedSandboxIds: [],
          listOptions: { tags: [tag] },
          pollTimeoutMs: 30_000,
        });
        expect(remaining).toEqual([]);
        const recovered = await waitUntilFromIdTerminal(client, sandboxId);
        await expectTerminalStatus(recovered);
        expect(recovered.sandboxId).toBe(sandboxId);
      },
      testTimeoutMs,
    );

    it(
      "fromId of a never-created id returns a typed not-found error",
      async () => {
        const sandboxId = randomUUID();
        const error = await rejectAndNarrow(
          () => client.fromId(sandboxId),
          (value): value is CWSandboxNotFoundError => value instanceof CWSandboxNotFoundError,
        );
        expect(error.code).toBe("not_found");
        expect(error.sandboxId).toBe(sandboxId);
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
            await expect(
              sandbox.wait({ targetStatus: "completed", timeoutMs: testTimeoutMs }),
            ).resolves.toBe(sandbox);
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

async function withProcessCleanup<TProcess extends CommandProcess>(
  start: () => Promise<TProcess>,
  body: (process: TProcess) => Promise<void>,
): Promise<void> {
  const process = await start();
  const primary = await captureOp(async () => {
    await body(process);
  });
  const cleanup = await captureOp(async () => {
    if (process.status === "running" || process.status === "starting") {
      await process.cancel();
    }
  });
  combineCleanupError(primary, cleanup);
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

function numberedLogLines(bytes: Uint8Array): string[] {
  const complete = new TextDecoder().decode(bytes).split("\n").slice(0, -1);
  return complete.map((line) => line.trim()).filter((line) => line.startsWith("line-"));
}
