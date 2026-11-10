// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * Local half of `files.uploadDirectory`: walk, deterministic archive, parts and
 * the remote scripts. The archive must be byte-identical across calls on an
 * unchanged tree so a later call can resume from parts an earlier call
 * staged. The remote scripts, exit codes, staging names, manifest format and
 * exclude rules are shared verbatim with the Python SDK; change both together.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { pipeline, Readable } from "node:stream";
import { createGzip } from "node:zlib";

import { CWSandboxFileError, CWSandboxValidationError } from "../errors.js";

export const PART_SIZE = 32 * 1024 * 1024;
export const STAGING_PREFIX = ".cwsandbox-upload-";
export const MANIFEST_HEADER = "cwsandbox-directory-upload/1";
export const READ_CHUNK_SIZE = 1024 * 1024;
export const GZIP_LEVEL = 6;
export const TAR_BLOCK_SIZE = 512;
export const TAR_RECORD_SIZE = 10240;

export const PREFLIGHT_TIMEOUT_MS = 60_000;
export const PART_ATTEMPT_TIMEOUT_MS = 300_000;
export const FINAL_TIMEOUT_MS = 1_800_000;
export const PART_MAX_ATTEMPTS = 3;
export const PART_RETRY_DELAYS_MS = [1_000, 2_000] as const;

export const BASE_TOOLS = ["tar", "sha256sum", "head", "wc", "cat", "mv", "rm", "mkdir"] as const;

// Script exit codes: 20 missing tools, 21 not writable (preflight); 40 write
// failed, 41 size, 42 checksum (part); 30 missing part, 31 checksum, 32 tar
// failed (final).
export const EXIT_MISSING_TOOLS = 20;
export const EXIT_MISSING_PART = 30;
export const EXIT_ARCHIVE_CHECKSUM = 31;
export const EXIT_PART_SIZE = 41;
export const EXIT_PART_CHECKSUM = 42;

export const PART_NAME_RE = /^[0-9]{6}-[0-9a-f]{64}\.part$/;

export const PREFLIGHT_SCRIPT = `dest=$1
stage=$2
shift 2
missing=
for tool in "$@"; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  printf 'missing tools:%s\\n' "$missing" >&2
  exit 20
fi
if ! mkdir -p -- "$dest" "$stage" 2>/dev/null || [ ! -d "$stage" ] || [ ! -w "$stage" ]; then
  printf 'not a writable directory: %s\\n' "$dest" >&2
  exit 21
fi
if command -v find >/dev/null 2>&1; then
  find "$dest" -maxdepth 1 -type d -name '.cwsandbox-upload-*' ! -name "\${stage##*/}" \\
    -mmin +1440 -exec rm -rf -- {} + 2>/dev/null
fi
touch -- "$stage" 2>/dev/null
for part in "$stage"/*.part; do
  [ -f "$part" ] && printf '%s\\n' "\${part##*/}"
done
exit 0
`;

export const PART_SCRIPT = `stage=$1
index=$2
size=$3
sum=$4
tmp="$stage/.tmp-$index-$$"
trap 'rm -f -- "$tmp"' EXIT
for old in "$stage/$index"-*.part; do
  [ "$old" = "$stage/$index-$sum.part" ] || rm -f -- "$old"
done
if ! head -c "$size" > "$tmp"; then
  printf 'failed to write part %s\\n' "$index" >&2
  exit 40
fi
actual=$(wc -c < "$tmp") || exit 40
set -- $actual
if [ "$1" != "$size" ]; then
  printf 'part %s: expected %s bytes, received %s\\n' "$index" "$size" "$1" >&2
  exit 41
fi
got=$(sha256sum < "$tmp") || exit 42
got=\${got%% *}
if [ "$got" != "$sum" ]; then
  printf 'part %s: checksum mismatch\\n' "$index" >&2
  exit 42
fi
if ! mv -f -- "$tmp" "$stage/$index-$sum.part"; then
  printf 'failed to commit part %s\\n' "$index" >&2
  exit 40
fi
exit 0
`;

export const FINAL_SCRIPT = `dest=$1
stage=$2
sum=$3
z=$4
shift 4
cd -- "$stage" || exit 30
for part in "$@"; do
  if [ ! -f "$part" ]; then
    printf 'missing staged part: %s\\n' "$part" >&2
    exit 30
  fi
done
got=$(cat -- "$@" | sha256sum) || exit 31
got=\${got%% *}
if [ "$got" != "$sum" ]; then
  printf 'archive checksum mismatch: expected %s, got %s\\n' "$sum" "$got" >&2
  cd / && rm -rf -- "$stage"
  exit 31
fi
if [ "$z" = z ]; then flags=-xzof; else flags=-xof; fi
if ! cat -- "$@" | tar "$flags" - -C "$dest"; then
  printf 'tar failed extracting into %s\\n' "$dest" >&2
  exit 32
fi
cd / && rm -rf -- "$stage"
exit 0
`;

export type UploadStage = "archive" | "extract" | "preflight" | "transfer" | "verify";

/** One archived path: `d` (directory), `f` (file) or `l` (symlink). */
export interface UploadEntry {
  readonly kind: "d" | "f" | "l";
  readonly name: string;
  readonly mode: number;
  readonly size: number;
  readonly mtime: number;
  readonly target: string;
  readonly path: string;
}

export interface UploadPlan {
  readonly entries: readonly UploadEntry[];
  readonly skipped: readonly string[];
  readonly totalBytes: number;
  readonly key: string;
}

export interface ArchivePart {
  readonly index: number;
  readonly data: Uint8Array;
  readonly sha256: string;
  readonly sourceBytesDone: number;
  readonly name: string;
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export function uploadError(
  message: string,
  stage: UploadStage,
  remotePath: string,
  metadata: Readonly<Record<string, string>> = {},
  sandboxId?: string,
): CWSandboxFileError {
  return new CWSandboxFileError(message, {
    filepath: remotePath,
    metadata: { operation: "upload_directory", stage, ...metadata },
    operation: "Upload directory",
    ...(sandboxId === undefined ? {} : { sandboxId }),
  });
}

export function normalizeRemotePath(remotePath: unknown): string {
  if (typeof remotePath !== "string") {
    throw new CWSandboxValidationError("uploadDirectory remotePath must be a string.");
  }
  if (!remotePath.startsWith("/") || remotePath.includes("\0")) {
    throw new CWSandboxValidationError(
      `uploadDirectory remotePath must be an absolute path, got ${JSON.stringify(remotePath)}.`,
    );
  }
  const parts = remotePath.split("/").filter((part) => part !== "");
  if (parts.includes("..")) {
    throw new CWSandboxValidationError(
      `uploadDirectory remotePath must not contain '..', got ${JSON.stringify(remotePath)}.`,
    );
  }
  if (parts.length === 0) {
    throw new CWSandboxValidationError("uploadDirectory remotePath must not be the root.");
  }
  return `/${parts.join("/")}`;
}

export function normalizeExcludes(exclude: unknown): readonly string[] {
  if (exclude === undefined) {
    return [];
  }
  if (!Array.isArray(exclude)) {
    throw new CWSandboxValidationError("uploadDirectory exclude must be an array of globs.");
  }
  return exclude.map((pattern: unknown) => {
    if (typeof pattern !== "string" || pattern === "") {
      throw new CWSandboxValidationError("uploadDirectory exclude patterns must be non-empty.");
    }
    const stripped = pattern.replace(/^\/+|\/+$/g, "");
    if (stripped === "") {
      throw new CWSandboxValidationError(
        `uploadDirectory exclude pattern ${JSON.stringify(pattern)} matches nothing.`,
      );
    }
    return stripped;
  });
}

const regexCache = new Map<string, RegExp>();

/** Python `fnmatch.translate` semantics: `*` and `?` also match `/`. */
export function globToRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const chars = [...pattern];
  let out = "";
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] as string;
    if (c === "*") {
      out += "[\\s\\S]*";
    } else if (c === "?") {
      out += "[\\s\\S]";
    } else if (c === "[") {
      let j = i + 1;
      if (chars[j] === "!") {
        j += 1;
      }
      if (chars[j] === "]") {
        j += 1;
      }
      while (j < chars.length && chars[j] !== "]") {
        j += 1;
      }
      if (j >= chars.length) {
        out += "\\[";
      } else {
        let set = chars
          .slice(i + 1, j)
          .join("")
          .replace(/\\/g, "\\\\")
          .replace(/\[/g, "\\[");
        if (set.startsWith("!")) {
          set = `^${set.slice(1)}`;
        } else if (set.startsWith("^")) {
          set = `\\${set}`;
        }
        out += `[${set}]`;
        i = j;
      }
    } else {
      out += /[\^$\\.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c;
    }
  }
  const regex = new RegExp(`^${out}$`, "u");
  regexCache.set(pattern, regex);
  return regex;
}

export function isExcluded(name: string, relative: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    globToRegExp(pattern).test(pattern.includes("/") ? relative : name),
  );
}

/** Whether a link target is absolute or resolves (lexically) outside the tree. */
export function symlinkEscapes(relative: string, target: string): boolean {
  if (target === "" || target.startsWith("/")) {
    return true;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(relative), target));
  const trimmed = resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
  return trimmed === ".." || trimmed.startsWith("../");
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Canonical walk manifest; its hash is the resume key (shared with Python). */
export function manifestBytes(entries: readonly UploadEntry[], compress: boolean): Uint8Array {
  const lines = [MANIFEST_HEADER, compress ? "gzip" : "tar"];
  for (const entry of entries) {
    lines.push(
      `${entry.kind} ${entry.mode.toString(8)} ${entry.size} ${entry.mtime} ` +
        `${byteLength(entry.name)}:${entry.name} ${byteLength(entry.target)}:${entry.target}`,
    );
  }
  return encoder.encode(`${lines.join("\n")}\n`);
}

export function contentKey(entries: readonly UploadEntry[], compress: boolean): string {
  return createHash("sha256").update(manifestBytes(entries, compress)).digest("hex").slice(0, 32);
}

function comparePaths(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const order = Buffer.compare(Buffer.from(left[i] as string), Buffer.from(right[i] as string));
    if (order !== 0) {
      return order;
    }
  }
  return left.length - right.length;
}

function entryMode(mode: number, kind: UploadEntry["kind"]): number {
  if (process.platform === "win32") {
    return kind === "d" ? 0o755 : kind === "l" ? 0o777 : 0o644;
  }
  return mode & 0o777;
}

/** Walk `localPath` into a deterministic, pre-ordered entry list. */
export async function scanDirectory(
  localPath: string,
  patterns: readonly string[],
  compress: boolean,
  remotePath: string,
): Promise<UploadPlan> {
  const root = await realpath(localPath);
  const entries: UploadEntry[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  const stack: [string, string][] = [[root, ""]];
  while (stack.length > 0) {
    const [directory, prefix] = stack.pop() as [string, string];
    let names: Buffer[];
    try {
      names = await readdir(directory, { encoding: "buffer" });
    } catch (error) {
      throw uploadError(
        `Cannot list local directory '${directory}': ${String(error)}`,
        "archive",
        remotePath,
        { path: prefix || "." },
      );
    }
    names.sort(Buffer.compare);
    for (const raw of names) {
      let name: string;
      try {
        name = strictDecoder.decode(raw);
      } catch {
        const shown = `${prefix ? `${prefix}/` : ""}${raw.toString("utf8")}`;
        throw uploadError(`Local path name is not valid UTF-8: ${shown}`, "archive", remotePath, {
          path: shown,
        });
      }
      const relative = prefix ? `${prefix}/${name}` : name;
      if (isExcluded(name, relative, patterns)) {
        continue;
      }
      const full = join(directory, name);
      let st;
      try {
        st = await lstat(full);
      } catch (error) {
        throw uploadError(
          `Cannot read local path '${relative}': ${String(error)}`,
          "archive",
          remotePath,
          {
            path: relative,
          },
        );
      }
      const mtime = Math.trunc(st.mtimeMs / 1000);
      if (st.isDirectory()) {
        entries.push({
          kind: "d",
          mode: entryMode(st.mode, "d"),
          mtime,
          name: relative,
          path: full,
          size: 0,
          target: "",
        });
        stack.push([full, relative]);
      } else if (st.isFile()) {
        entries.push({
          kind: "f",
          mode: entryMode(st.mode, "f"),
          mtime,
          name: relative,
          path: full,
          size: st.size,
          target: "",
        });
        totalBytes += st.size;
      } else if (st.isSymbolicLink()) {
        const target = await readlink(full);
        if (symlinkEscapes(relative, target)) {
          throw uploadError(
            `Symbolic link '${relative}' -> '${target}' points outside the uploaded directory; ` +
              "remove it or add it to exclude",
            "archive",
            remotePath,
            { path: relative },
          );
        }
        entries.push({
          kind: "l",
          mode: entryMode(st.mode, "l"),
          mtime,
          name: relative,
          path: full,
          size: 0,
          target,
        });
      } else {
        skipped.push(relative);
      }
    }
  }
  // Sorting by path components gives pre-order (a directory before its
  // children) with siblings in UTF-8 byte order, whatever order we walked in.
  entries.sort((a, b) => comparePaths(a.name, b.name));
  skipped.sort(comparePaths);
  return { entries, key: contentKey(entries, compress), skipped, totalBytes };
}

function writeString(block: Uint8Array, offset: number, length: number, value: Uint8Array): void {
  block.set(value.subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeString(
    block,
    offset,
    length,
    encoder.encode(`${value.toString(8).padStart(length - 1, "0")}\0`),
  );
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = byteLength(body) + 1;
  while (String(length).length + byteLength(body) !== length) {
    length = String(length).length + byteLength(body);
  }
  return `${length}${body}`;
}

function needsPax(value: string, limit: number): boolean {
  // eslint-disable-next-line no-control-regex
  return byteLength(value) > limit || /[^\x00-\x7f]/.test(value);
}

function ustarHeader(options: {
  name: string;
  mode: number;
  size: number;
  mtime: number;
  type: string;
  linkname?: string;
}): Uint8Array {
  const block = new Uint8Array(TAR_BLOCK_SIZE);
  writeString(block, 0, 100, encoder.encode(options.name));
  writeOctal(block, 100, 8, options.mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, options.size);
  writeOctal(block, 136, 12, options.mtime);
  block.fill(0x20, 148, 156);
  block[156] = options.type.charCodeAt(0);
  writeString(block, 157, 100, encoder.encode(options.linkname ?? ""));
  writeString(block, 257, 8, encoder.encode("ustar\x0000"));
  writeOctal(block, 329, 8, 0);
  writeOctal(block, 337, 8, 0);
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  writeString(block, 148, 8, encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `));
  return block;
}

const MAX_USTAR_SIZE = 8 ** 11 - 1;

export function tarHeader(entry: UploadEntry): Uint8Array {
  const name = entry.kind === "d" ? `${entry.name}/` : entry.name;
  const records: string[] = [];
  if (needsPax(name, 100)) {
    records.push(paxRecord("path", name));
  }
  if (entry.kind === "l" && needsPax(entry.target, 100)) {
    records.push(paxRecord("linkpath", entry.target));
  }
  if (entry.size > MAX_USTAR_SIZE) {
    records.push(paxRecord("size", String(entry.size)));
  }
  const header = ustarHeader({
    linkname: entry.target,
    mode: entry.mode,
    mtime: entry.mtime,
    name,
    size: entry.size > MAX_USTAR_SIZE ? 0 : entry.size,
    type: entry.kind === "d" ? "5" : entry.kind === "l" ? "2" : "0",
  });
  if (records.length === 0) {
    return header;
  }
  const pax = encoder.encode(records.join(""));
  const paxHeader = ustarHeader({
    mode: 0o644,
    mtime: 0,
    name: "././@PaxHeader",
    size: pax.byteLength,
    type: "x",
  });
  const padding = (TAR_BLOCK_SIZE - (pax.byteLength % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
  const out = new Uint8Array(TAR_BLOCK_SIZE + pax.byteLength + padding + TAR_BLOCK_SIZE);
  out.set(paxHeader, 0);
  out.set(pax, TAR_BLOCK_SIZE);
  out.set(header, TAR_BLOCK_SIZE + pax.byteLength + padding);
  return out;
}

function changed(entry: UploadEntry, remotePath: string): CWSandboxFileError {
  return uploadError(
    `Local file '${entry.name}' changed during upload; retry when it is stable`,
    "archive",
    remotePath,
    { path: entry.name },
  );
}

/** Counter shared with the part cutter so progress follows source bytes read. */
export interface SourceCounter {
  bytes: number;
}

/** Tar bytes without buffering whole files. */
export async function* iterTar(
  plan: UploadPlan,
  remotePath: string,
  counter: SourceCounter = { bytes: 0 },
): AsyncGenerator<Uint8Array> {
  let written = 0;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  for (const entry of plan.entries) {
    const header = tarHeader(entry);
    written += header.byteLength;
    yield header;
    if (entry.kind !== "f") {
      continue;
    }
    let handle;
    try {
      handle = await open(entry.path, flags);
    } catch {
      throw changed(entry, remotePath);
    }
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size !== entry.size || Math.trunc(st.mtimeMs / 1000) !== entry.mtime) {
        throw changed(entry, remotePath);
      }
      let remaining = entry.size;
      while (remaining > 0) {
        const buffer = new Uint8Array(Math.min(READ_CHUNK_SIZE, remaining));
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) {
          throw changed(entry, remotePath);
        }
        remaining -= bytesRead;
        written += bytesRead;
        counter.bytes += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    } finally {
      await handle.close();
    }
    const padding = (TAR_BLOCK_SIZE - (entry.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (padding > 0) {
      written += padding;
      yield new Uint8Array(padding);
    }
  }
  let trailer = 2 * TAR_BLOCK_SIZE;
  trailer += (TAR_RECORD_SIZE - ((written + trailer) % TAR_RECORD_SIZE)) % TAR_RECORD_SIZE;
  yield new Uint8Array(trailer);
}

/** Tar stream, gzip-compressed (level 6, no name, mtime 0) when `compress`. */
export async function* iterArchive(
  plan: UploadPlan,
  compress: boolean,
  remotePath: string,
  counter: SourceCounter,
): AsyncGenerator<Uint8Array> {
  if (!compress) {
    yield* iterTar(plan, remotePath, counter);
    return;
  }
  const gzip = createGzip({ level: GZIP_LEVEL });
  // pipeline() destroys gzip with the source's error, so a local read
  // failure surfaces from the loop below instead of ending the stream early.
  pipeline(Readable.from(iterTar(plan, remotePath, counter)), gzip, () => undefined);
  for await (const chunk of gzip) {
    yield new Uint8Array(chunk as Buffer);
  }
}

export function partName(index: number, sha256: string): string {
  return `${String(index).padStart(6, "0")}-${sha256}.part`;
}

function makePart(index: number, data: Uint8Array, sourceBytesDone: number): ArchivePart {
  const sha256 = createHash("sha256").update(data).digest("hex");
  return { data, index, name: partName(index, sha256), sha256, sourceBytesDone };
}

/** Cut the archive into `PART_SIZE` slices; always yields at least one part. */
export async function* iterParts(
  plan: UploadPlan,
  compress: boolean,
  remotePath: string,
  partSize: number = PART_SIZE,
): AsyncGenerator<ArchivePart> {
  const counter: SourceCounter = { bytes: 0 };
  let buffer = new Uint8Array(partSize);
  let filled = 0;
  let index = 0;
  for await (let chunk of iterArchive(plan, compress, remotePath, counter)) {
    while (chunk.byteLength > 0) {
      const take = Math.min(partSize - filled, chunk.byteLength);
      buffer.set(chunk.subarray(0, take), filled);
      filled += take;
      chunk = chunk.subarray(take);
      if (filled === partSize) {
        yield makePart(index, buffer, counter.bytes);
        index += 1;
        buffer = new Uint8Array(partSize);
        filled = 0;
      }
    }
  }
  if (filled > 0 || index === 0) {
    yield makePart(index, buffer.slice(0, filled), counter.bytes);
  }
}

export function requiredTools(compress: boolean): string[] {
  return compress ? [...BASE_TOOLS, "gzip"] : [...BASE_TOOLS];
}
