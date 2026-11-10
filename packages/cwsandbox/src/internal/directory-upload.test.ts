// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { CWSandboxFileError, CWSandboxValidationError } from "../errors.js";
import {
  FINAL_SCRIPT,
  PART_SCRIPT,
  PART_SIZE,
  PREFLIGHT_SCRIPT,
  READ_CHUNK_SIZE,
  TAR_RECORD_SIZE,
  type UploadEntry,
  contentKey,
  isExcluded,
  iterParts,
  iterTar,
  manifestBytes,
  normalizeExcludes,
  normalizeRemotePath,
  scanDirectory,
  symlinkEscapes,
} from "./directory-upload.js";

// Shared with the Python SDK: same inputs must give the same key.
const KEY_VECTOR_ENTRIES: UploadEntry[] = [
  { kind: "d", mode: 0o755, mtime: 1700000000, name: "src", path: "", size: 0, target: "" },
  { kind: "f", mode: 0o644, mtime: 1700000001, name: "src/a.txt", path: "", size: 5, target: "" },
  {
    kind: "l",
    mode: 0o777,
    mtime: 1700000002,
    name: "src/link",
    path: "",
    size: 0,
    target: "a.txt",
  },
];
const KEY_VECTOR_MANIFEST =
  "cwsandbox-directory-upload/1\n" +
  "gzip\n" +
  "d 755 0 1700000000 3:src 0:\n" +
  "f 644 5 1700000001 9:src/a.txt 0:\n" +
  "l 777 0 1700000002 8:src/link 5:a.txt\n";
const KEY_VECTOR_KEY = "03894960432b2c9b57ee9b554541eda2";

// Shared with the Python SDK: [pattern, relative path, excluded].
const EXCLUDE_VECTORS: [string, string, boolean][] = [
  [".git", ".git", true],
  [".git", "sub/.git", true],
  ["*.pyc", "a/b/c.pyc", true],
  ["build/*.o", "build/x.o", true],
  ["build/*.o", "src/build/x.o", false],
  ["/docs/private/", "docs/private", true],
  ["node_modules", "node_modules_old", false],
  ["a?c", "abc", true],
  ["[!x]y", "zy", true],
  ["src/*", "src/a/b", true],
];

interface TarMember {
  readonly name: string;
  readonly type: string;
  readonly mode: number;
  readonly uid: number;
  readonly linkname: string;
  readonly data: Uint8Array;
}

/** Minimal ustar + PAX reader for assertions. */
function readTar(archive: Uint8Array): TarMember[] {
  const decoder = new TextDecoder();
  const field = (block: Uint8Array, offset: number, length: number) =>
    decoder.decode(block.subarray(offset, offset + length)).replace(/\0.*$/s, "");
  const members: TarMember[] = [];
  let pax: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= archive.byteLength;) {
    const block = archive.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      break;
    }
    const size = Number.parseInt(field(block, 124, 12), 8);
    const type = String.fromCharCode(block[156] as number);
    const data = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = {};
      for (const record of decoder.decode(data).split("\n").filter(Boolean)) {
        const [key, ...value] = record.slice(record.indexOf(" ") + 1).split("=");
        pax[key as string] = value.join("=");
      }
      continue;
    }
    members.push({
      data,
      linkname: pax["linkpath"] ?? field(block, 157, 100),
      mode: Number.parseInt(field(block, 100, 8), 8),
      name: (pax["path"] ?? field(block, 0, 100)).replace(/\/$/, ""),
      type,
      uid: Number.parseInt(field(block, 108, 8), 8),
    });
    pax = {};
  }
  return members;
}

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cws-upload-"));
  await mkdir(join(root, "pkg", "sub"), { recursive: true });
  await writeFile(join(root, "pkg", "sub", "data.txt"), "data");
  await writeFile(join(root, "pkg", "run.sh"), "#!/bin/sh\n");
  await chmod(join(root, "pkg", "run.sh"), 0o755);
  await symlink("sub/data.txt", join(root, "pkg", "link"));
  await mkdir(join(root, "empty"));
  await writeFile(join(root, "skip.pyc"), "x");
  await writeFile(join(root, "n".repeat(120)), "long");
  await writeFile(join(root, "café.txt"), "u");
  return root;
}

async function archiveOf(root: string, compress: boolean, partSize?: number) {
  const plan = await scanDirectory(root, [], compress, "/w");
  const parts = [];
  for await (const part of iterParts(plan, compress, "/w", partSize)) {
    parts.push(part);
  }
  return { parts, plan };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(chunks));
}

// Shared with the Python SDK: the remote scripts must stay byte-identical.
const SCRIPT_SHA256: Record<string, [string, string]> = {
  FINAL_SCRIPT: [FINAL_SCRIPT, "21239579a8378024a1dd0603fe9b595f060a99878158f490a0da28fc46f97623"],
  PART_SCRIPT: [PART_SCRIPT, "50d726dee5281f5dd5a86d373d729a68b64f3346f31f3538c673c1d0e2de879a"],
  PREFLIGHT_SCRIPT: [
    PREFLIGHT_SCRIPT,
    "029e4958f0051615488abfdb50a27f79d488ad6301da5663248a6ac2b4fcd767",
  ],
};

describe("directory upload manifest and excludes", () => {
  it.each(Object.entries(SCRIPT_SHA256))("%s matches the Python SDK", (_, [script, digest]) => {
    expect(createHash("sha256").update(script).digest("hex")).toBe(digest);
  });

  it("matches the shared key vector", () => {
    expect(new TextDecoder().decode(manifestBytes(KEY_VECTOR_ENTRIES, true))).toBe(
      KEY_VECTOR_MANIFEST,
    );
    expect(contentKey(KEY_VECTOR_ENTRIES, true)).toBe(KEY_VECTOR_KEY);
    expect(contentKey(KEY_VECTOR_ENTRIES, false)).not.toBe(KEY_VECTOR_KEY);
  });

  it.each(EXCLUDE_VECTORS)("exclude %s on %s is %s", (pattern, relative, excluded) => {
    const name = relative.split("/").at(-1) as string;
    expect(isExcluded(name, relative, normalizeExcludes([pattern]))).toBe(excluded);
  });

  it.each([
    ["a/link", "b.txt", false],
    ["a/link", "../top.txt", false],
    ["link", ".", false],
    ["link", "/etc/passwd", true],
    ["link", "..", true],
    ["a/link", "../../x", true],
    ["a/link", "b/../../../x", true],
    ["link", "", true],
  ] as const)("symlink %s -> %s escapes: %s", (relative, target, escapes) => {
    expect(symlinkEscapes(relative, target)).toBe(escapes);
  });

  it("validates remote paths and excludes", () => {
    expect(normalizeRemotePath("//w//x/")).toBe("/w/x");
    for (const bad of ["relative/x", "/", "/a/../b", 3]) {
      expect(() => normalizeRemotePath(bad)).toThrow(CWSandboxValidationError);
    }
    expect(() => normalizeExcludes("*.pyc")).toThrow(CWSandboxValidationError);
    expect(() => normalizeExcludes([""])).toThrow(CWSandboxValidationError);
  });
});

describe("directory upload walk and archive", () => {
  it("walks in pre-order with UTF-8 sibling order, excludes and skips", async () => {
    const root = await makeTree();
    await mkdir(join(root, "pkg", "node_modules"));
    await writeFile(join(root, "pkg", "node_modules", "dep.js"), "x");
    const plan = await scanDirectory(
      root,
      normalizeExcludes(["*.pyc", "node_modules"]),
      true,
      "/w",
    );
    expect(plan.entries.map((entry) => entry.name)).toEqual([
      "café.txt",
      "empty",
      "n".repeat(120),
      "pkg",
      "pkg/link",
      "pkg/run.sh",
      "pkg/sub",
      "pkg/sub/data.txt",
    ]);
    expect(plan.totalBytes).toBe(4 + 10 + 4 + 1);
  });

  it("rejects a symlink that leaves the tree and names it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cws-upload-"));
    await symlink("/etc/passwd", join(root, "out"));
    const error = await scanDirectory(root, [], true, "/w").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CWSandboxFileError);
    expect((error as CWSandboxFileError).metadata).toMatchObject({ path: "out", stage: "archive" });
    expect(String(error)).toContain("exclude");
    await expect(scanDirectory(root, ["out"], true, "/w")).resolves.toMatchObject({ entries: [] });
  });

  it.each([true, false])("round-trips the archive (compress=%s)", async (compress) => {
    const root = await makeTree();
    await chmod(join(root, "pkg", "run.sh"), 0o4755);
    const { parts, plan } = await archiveOf(root, compress);
    const raw = concat(parts.map((part) => part.data));
    const tar = compress ? new Uint8Array(gunzipSync(raw)) : raw;
    expect(tar.byteLength % TAR_RECORD_SIZE).toBe(0);
    const members = readTar(tar);
    expect(members.map((member) => member.name)).toEqual(plan.entries.map((entry) => entry.name));
    const byName = new Map(members.map((member) => [member.name, member]));
    expect(byName.get("pkg/run.sh")?.mode).toBe(0o755);
    expect(byName.get("pkg/link")).toMatchObject({ linkname: "sub/data.txt", type: "2" });
    expect(new TextDecoder().decode(byName.get("n".repeat(120))?.data)).toBe("long");
    expect(new TextDecoder().decode(byName.get("café.txt")?.data)).toBe("u");
    expect(byName.get("pkg")?.type).toBe("5");
    expect(members.every((member) => member.uid === 0)).toBe(true);
  });

  it("is deterministic and cuts fixed-size parts", async () => {
    const root = await makeTree();
    await writeFile(join(root, "big.bin"), randomBytes(5000));
    const first = await archiveOf(root, true, 1024);
    const second = await archiveOf(root, true, 1024);
    expect(first.parts.map((part) => part.sha256)).toEqual(second.parts.map((part) => part.sha256));
    expect(first.parts.length).toBeGreaterThan(2);
    expect(first.parts.slice(0, -1).every((part) => part.data.byteLength === 1024)).toBe(true);
    expect(first.parts.map((part) => part.index)).toEqual(first.parts.map((_, index) => index));
    expect(first.parts.at(-1)?.sourceBytesDone).toBe(first.plan.totalBytes);
    const part = first.parts[0];
    expect(part?.name).toBe(
      `000000-${createHash("sha256")
        .update(part?.data ?? new Uint8Array())
        .digest("hex")}.part`,
    );
  });

  it("streams a large file without buffering it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cws-upload-"));
    const handle = await open(join(root, "sparse.bin"), "w");
    await handle.truncate(64 * 1024 * 1024);
    await handle.close();
    const plan = await scanDirectory(root, [], false, "/w");
    let largest = 0;
    for await (const chunk of iterTar(plan, "/w")) {
      largest = Math.max(largest, chunk.byteLength);
    }
    expect(largest).toBeLessThanOrEqual(READ_CHUNK_SIZE);
    const sizes = [];
    for await (const part of iterParts(plan, false, "/w")) {
      sizes.push(part.data.byteLength);
    }
    expect(sizes.slice(0, -1)).toEqual([PART_SIZE, PART_SIZE]);
  });

  it("fails with stage archive when a file changes during the upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "cws-upload-"));
    await writeFile(join(root, "grow.txt"), "abc");
    const plan = await scanDirectory(root, [], true, "/w");
    await writeFile(join(root, "grow.txt"), "abcdef");
    await utimes(join(root, "grow.txt"), new Date(), new Date());
    const consume = async () => {
      for await (const _ of iterParts(plan, true, "/w")) {
        // drain
      }
    };
    const error = await consume().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CWSandboxFileError);
    expect((error as CWSandboxFileError).metadata).toEqual({
      operation: "upload_directory",
      path: "grow.txt",
      stage: "archive",
    });
  });
});
