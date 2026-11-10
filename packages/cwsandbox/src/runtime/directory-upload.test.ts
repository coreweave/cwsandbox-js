// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CWSandboxFileError,
  CWSandboxNotFoundError,
  CWSandboxTimeoutError,
  CWSandboxUnavailableError,
  CWSandboxValidationError,
} from "../errors.js";
import {
  BASE_TOOLS,
  FINAL_SCRIPT,
  STAGING_PREFIX,
  scanDirectory,
} from "../internal/directory-upload.js";
import { createClient, createFakeFileAdapter } from "../test/helpers.js";
import type { RunScriptRequest, RunScriptResult } from "../transport/file-adapter.js";

const toolsPresent = [...BASE_TOOLS, "gzip"].every(
  (tool) => spawnSync("/bin/sh", ["-c", `command -v ${tool}`]).status === 0,
);

type Inject = (argv0: string, args: string[]) => Error | RunScriptResult | undefined;

/** Runs the real remote scripts with the local /bin/sh in place of an exec. */
function localRemote(inject?: Inject) {
  const calls: { argv0: string; args: string[]; container?: string; stdin?: Uint8Array }[] = [];
  async function runScript(request: RunScriptRequest): Promise<RunScriptResult> {
    const [, , , argv0, ...args] = request.command;
    calls.push({
      args,
      argv0: argv0 as string,
      ...(request.container === undefined ? {} : { container: request.container }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    });
    const injected = inject?.(argv0 as string, args);
    if (injected instanceof Error) {
      throw injected;
    }
    if (injected !== undefined) {
      return injected;
    }
    const proc = spawnSync(request.command[0], request.command.slice(1), {
      input: request.stdin ?? new Uint8Array(),
    });
    return {
      exitCode: proc.status ?? -1,
      stderr: proc.stderr.toString().trim(),
      stdout: proc.stdout.toString(),
    };
  }
  return { calls, names: () => calls.map((call) => call.argv0), runScript };
}

async function sandboxWith(remote: ReturnType<typeof localRemote>) {
  return createClient(undefined, createFakeFileAdapter({ runScript: remote.runScript })).run([
    "sleep",
    "infinity",
  ]);
}

async function makeTree(root: string): Promise<void> {
  await mkdir(join(root, "pkg", "sub"), { recursive: true });
  await writeFile(join(root, "pkg", "sub", "data.txt"), "data");
  await writeFile(join(root, "pkg", "run.sh"), "#!/bin/sh\n");
  await chmod(join(root, "pkg", "run.sh"), 0o755);
  await symlink("sub/data.txt", join(root, "pkg", "link"));
  await mkdir(join(root, "empty"));
  await writeFile(join(root, "skip.pyc"), "x");
  await writeFile(join(root, "n".repeat(120)), "long");
}

async function listing(root: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(root, rel);
    const info = await import("node:fs/promises").then((fs) => fs.lstat(full));
    if (info.isSymbolicLink()) {
      out[rel] = `l ${await readlink(full)}`;
    } else if (info.isDirectory()) {
      out[rel] = `d ${(info.mode & 0o777).toString(8)}`;
      Object.assign(out, await listing(root, rel));
    } else {
      out[rel] = `f ${(info.mode & 0o777).toString(8)} ${await readFile(full, "utf8")}`;
    }
  }
  return out;
}

async function dirs() {
  const base = await mkdtemp(join(tmpdir(), "cws-upload-rt-"));
  const local = join(base, "local");
  const dest = join(base, "dest");
  await mkdir(local);
  return { base, dest, local };
}

const staged = (dest: string) =>
  existsSync(dest) ? readdirSync(dest).filter((name) => name.startsWith(STAGING_PREFIX)) : [];

describe("files.uploadDirectory validation", () => {
  it("rejects bad arguments before any exec", async () => {
    const remote = localRemote();
    const sandbox = await sandboxWith(remote);
    const { local } = await dirs();
    await writeFile(join(local, "file"), "x");
    for (const bad of ["relative", "/", "/a/../b"]) {
      await expect(sandbox.files.uploadDirectory(local, bad)).rejects.toThrow(
        CWSandboxValidationError,
      );
    }
    await expect(sandbox.files.uploadDirectory(join(local, "missing"), "/w")).rejects.toThrow(
      CWSandboxValidationError,
    );
    await expect(sandbox.files.uploadDirectory(join(local, "file"), "/w")).rejects.toThrow(
      CWSandboxValidationError,
    );
    expect(remote.calls).toEqual([]);
  });
});

describe.runIf(toolsPresent)("files.uploadDirectory with a local shell", () => {
  it("sends preflight, parts and final, and extracts the tree", async () => {
    const { dest, local } = await dirs();
    await makeTree(local);
    await mkdir(dest);
    await writeFile(join(dest, "keep.txt"), "remote");
    const remote = localRemote();
    const progress: [number, number][] = [];
    const sandbox = await sandboxWith(remote);

    const result = await sandbox.files.uploadDirectory(local, dest, {
      container: "sidecar",
      exclude: ["*.pyc"],
      onProgress: ({ bytesDone, bytesTotal }) => progress.push([bytesDone, bytesTotal]),
    });

    expect(remote.names()).toEqual([
      "cwsandbox-upload-preflight",
      "cwsandbox-upload-part",
      "cwsandbox-upload-final",
    ]);
    const [preflight, part, final] = remote.calls;
    const plan = await scanDirectory(local, ["*.pyc"], true, dest);
    const stage = `${dest}/${STAGING_PREFIX}${plan.key}`;
    expect(preflight?.args).toEqual([dest, stage, ...BASE_TOOLS, "gzip"]);
    expect(preflight?.stdin).toBeUndefined();
    expect(final?.stdin).toBeUndefined();
    expect(part?.args.slice(0, 3)).toEqual([stage, "000000", String(part?.stdin?.byteLength)]);
    expect(final?.args.slice(0, 4)).toEqual([dest, stage, result.sha256, "z"]);
    expect(new Set(remote.calls.map((call) => call.container))).toEqual(new Set(["sidecar"]));

    const expected = await listing(local);
    delete expected["skip.pyc"];
    const got = await listing(dest);
    expect(got["keep.txt"]).toBe("f 644 remote");
    delete got["keep.txt"];
    expect(got).toEqual(expected);
    expect(staged(dest)).toEqual([]);
    expect(result).toEqual({
      archiveBytes: part?.stdin?.byteLength,
      bytes: plan.totalBytes,
      directories: 3,
      files: 3,
      resumedBytes: 0,
      sha256: createHash("sha256")
        .update(part?.stdin ?? new Uint8Array())
        .digest("hex"),
      skipped: [],
      symlinks: 1,
    });
    expect(progress.at(-1)).toEqual([plan.totalBytes, plan.totalBytes]);
  });

  it("skips gzip when compress is false", async () => {
    const { dest, local } = await dirs();
    await makeTree(local);
    const remote = localRemote();
    await (await sandboxWith(remote)).files.uploadDirectory(local, dest, { compress: false });
    expect(remote.calls[0]?.args).not.toContain("gzip");
    expect(remote.calls.at(-1)?.args[3]).toBe("-");
    expect(await readFile(join(dest, "pkg", "sub", "data.txt"), "utf8")).toBe("data");
  });

  it("resumes after an interruption, sending only the missing parts", async () => {
    const { dest, local } = await dirs();
    const handle = await open(join(local, "big.bin"), "w");
    await handle.write(randomBytes(1024), 0, 1024, 33 * 1024 * 1024);
    await handle.close();
    const sandbox = await sandboxWith(
      localRemote((argv0, args) =>
        argv0 === "cwsandbox-upload-part" && args[1] === "000001"
          ? new CWSandboxNotFoundError("sandbox gone")
          : undefined,
      ),
    );
    await expect(sandbox.files.uploadDirectory(local, dest, { compress: false })).rejects.toThrow(
      CWSandboxNotFoundError,
    );
    const [stage] = staged(dest);
    expect(readdirSync(join(dest, stage as string)).map((name) => name.slice(0, 6))).toEqual([
      "000000",
    ]);

    const remote = localRemote();
    const result = await (
      await sandboxWith(remote)
    ).files.uploadDirectory(local, dest, {
      compress: false,
    });
    const sent = remote.calls.filter((call) => call.argv0 === "cwsandbox-upload-part");
    expect(sent.map((call) => call.args[1])).toEqual(["000001"]);
    expect(result.resumedBytes).toBe(32 * 1024 * 1024);
    expect((await stat(join(dest, "big.bin"))).size).toBe(33 * 1024 * 1024 + 1024);
    expect(staged(dest)).toEqual([]);
  });

  it("retries a part after a transient error and a checksum mismatch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    try {
      const { dest, local } = await dirs();
      await writeFile(join(local, "a.txt"), "hello");
      const failures: (Error | RunScriptResult)[] = [
        new CWSandboxUnavailableError("runner unavailable"),
        { exitCode: 42, stderr: "checksum", stdout: "" },
      ];
      const remote = localRemote((argv0) =>
        argv0 === "cwsandbox-upload-part" ? failures.shift() : undefined,
      );
      await (await sandboxWith(remote)).files.uploadDirectory(local, dest);
      expect(remote.names().filter((name) => name === "cwsandbox-upload-part")).toHaveLength(3);
      expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after three attempts and does not retry a write failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    try {
      const { dest, local } = await dirs();
      await writeFile(join(local, "a.txt"), "hello");
      const down = localRemote((argv0) =>
        argv0 === "cwsandbox-upload-part" ? new CWSandboxUnavailableError("down") : undefined,
      );
      await expect((await sandboxWith(down)).files.uploadDirectory(local, dest)).rejects.toThrow(
        CWSandboxUnavailableError,
      );
      expect(down.names().filter((name) => name === "cwsandbox-upload-part")).toHaveLength(3);

      const full = localRemote((argv0) =>
        argv0 === "cwsandbox-upload-part"
          ? { exitCode: 40, stderr: "failed to write part 000000", stdout: "" }
          : undefined,
      );
      const error = await (
        await sandboxWith(full)
      ).files
        .uploadDirectory(local, dest)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CWSandboxFileError);
      expect((error as CWSandboxFileError).metadata).toMatchObject({
        exit_code: "40",
        stage: "transfer",
      });
      expect(full.names().filter((name) => name === "cwsandbox-upload-part")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports missing tools from preflight", async () => {
    const { dest, local } = await dirs();
    const remote = localRemote(() => ({
      exitCode: 20,
      stderr: "missing tools: tar gzip",
      stdout: "",
    }));
    const error = await (
      await sandboxWith(remote)
    ).files
      .uploadDirectory(local, dest)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CWSandboxFileError);
    expect((error as CWSandboxFileError).metadata).toMatchObject({
      missing_tools: "tar gzip",
      stage: "preflight",
    });
    expect(String(error)).toContain("tar gzip");
    expect(remote.names()).toEqual(["cwsandbox-upload-preflight"]);
  });

  it("reports an unwritable destination from preflight", async () => {
    const { base, local } = await dirs();
    await writeFile(join(base, "file"), "x");
    const error = await (
      await sandboxWith(localRemote())
    ).files
      .uploadDirectory(local, join(base, "file", "sub"))
      .catch((caught: unknown) => caught);
    expect((error as CWSandboxFileError).metadata).toMatchObject({
      exit_code: "21",
      stage: "preflight",
    });
  });

  it("maps an archive checksum mismatch to stage verify and removes staging", async () => {
    const { dest, local } = await dirs();
    await writeFile(join(local, "a.txt"), "hello");
    const remote = localRemote((argv0, args) => {
      if (argv0 !== "cwsandbox-upload-final") {
        return undefined;
      }
      const proc = spawnSync("/bin/sh", [
        "-c",
        FINAL_SCRIPT,
        argv0,
        args[0] as string,
        args[1] as string,
        "0".repeat(64),
        ...args.slice(3),
      ]);
      return { exitCode: proc.status ?? -1, stderr: proc.stderr.toString().trim(), stdout: "" };
    });
    const error = await (
      await sandboxWith(remote)
    ).files
      .uploadDirectory(local, dest)
      .catch((caught: unknown) => caught);
    expect((error as CWSandboxFileError).metadata).toMatchObject({ stage: "verify" });
    expect(existsSync(join(dest, "a.txt"))).toBe(false);
    expect(staged(dest)).toEqual([]);
  });

  it("maps a tar failure to stage extract and keeps staging", async () => {
    const { dest, local } = await dirs();
    await writeFile(join(local, "clash"), "a file where the sandbox has a non-empty directory");
    await mkdir(join(dest, "clash"), { recursive: true });
    await writeFile(join(dest, "clash", "x"), "x");
    const error = await (
      await sandboxWith(localRemote())
    ).files
      .uploadDirectory(local, dest)
      .catch((caught: unknown) => caught);
    expect((error as CWSandboxFileError).metadata).toMatchObject({ stage: "extract" });
    expect(String(error)).toContain("may be partly updated");
    expect(staged(dest)).toHaveLength(1);
  });

  it("enforces the overall timeout", async () => {
    const { dest, local } = await dirs();
    const remote = localRemote((argv0) => {
      if (argv0 === "cwsandbox-upload-preflight") {
        spawnSync("sleep", ["0.05"]);
      }
      return undefined;
    });
    await expect(
      (await sandboxWith(remote)).files.uploadDirectory(local, dest, { timeoutMs: 10 }),
    ).rejects.toThrow(CWSandboxTimeoutError);
    expect(remote.names()).not.toContain("cwsandbox-upload-part");
  });
});
