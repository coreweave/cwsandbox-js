// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../errors.js";
import type {
  FileContent,
  FileWrite,
  FileWrites,
  MountedFile,
  MountedFiles,
} from "../public/files.js";

const textEncoder = new TextEncoder();

export function normalizeMountedFiles(
  mountedFiles: MountedFiles | undefined,
): readonly MountedFile[] {
  if (mountedFiles === undefined) {
    return [];
  }

  if (Array.isArray(mountedFiles)) {
    return mountedFiles;
  }

  return Object.entries(mountedFiles).map(([path, content]) => ({
    content,
    path,
  }));
}

export function normalizeFileContent(content: FileContent): Uint8Array {
  return typeof content === "string" ? textEncoder.encode(content) : content;
}

export function normalizeFileWrites(files: FileWrites): readonly FileWrite[] {
  if (Array.isArray(files)) {
    return files;
  }

  return Object.entries(files).map(([path, content]) => ({
    content,
    path,
  }));
}

export function validateFileWrites(files: FileWrites): void {
  validateUniqueAbsolutePaths(
    normalizeFileWrites(files).map((file) => file.path),
    "files.write path",
  );
}

export function validateReadPaths(paths: readonly string[]): void {
  validateUniqueAbsolutePaths(paths, "files.read path");
}

export function validateMountedFiles(mountedFiles: MountedFiles | undefined): void {
  validateUniqueAbsolutePaths(
    normalizeMountedFiles(mountedFiles).map((file) => file.path),
    "mountedFiles path",
  );
}

function validateUniqueAbsolutePaths(paths: readonly string[], fieldName: string): void {
  const seen = new Set<string>();

  for (const path of paths) {
    validateAbsolutePath(path, fieldName);

    if (seen.has(path)) {
      throw new CWSandboxValidationError(`${fieldName} contains duplicate path: ${path}`);
    }

    seen.add(path);
  }
}

export function validateAbsolutePath(path: string, fieldName: string): void {
  if (path === "") {
    throw new CWSandboxValidationError(`${fieldName} must not be empty`);
  }

  if (!path.startsWith("/")) {
    throw new CWSandboxValidationError(`${fieldName} must be absolute`);
  }
}
