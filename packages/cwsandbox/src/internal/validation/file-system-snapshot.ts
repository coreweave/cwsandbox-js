// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import path from "node:path";

import { CWSandboxValidationError } from "../../errors.js";
import type { MountedFiles } from "../../public/files.js";
import type { FileSystemSnapshotOptions } from "../../public/sandbox.js";
import { normalizeMountedFiles } from "../mounted-files.js";

const MAX_MOUNT_PATH_LENGTH = 256;

const RESERVED_MOUNT_PATH_PREFIXES = [
  "/proc",
  "/sys",
  "/dev",
  "/var/run/secrets",
  "/shared/credentials",
  "/etc",
] as const;

function posixClean(mountPath: string): string {
  const cleaned = path.posix.normalize(mountPath);
  if (cleaned.length > 1 && cleaned.endsWith("/")) {
    return cleaned.slice(0, -1);
  }
  return cleaned;
}

function pathEqualOrUnder(candidate: string, prefix: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

/**
 * Gateway `validateMountPathBase` (also applied to v1 volume mounts).
 */
export function validateMountPath(mountPath: string, field = "fileSystemSnapshot.mountPath"): void {
  if (mountPath === "") {
    throw new CWSandboxValidationError(`${field} is required.`);
  }
  if (mountPath.length > MAX_MOUNT_PATH_LENGTH) {
    throw new CWSandboxValidationError(
      `${field} must be at most ${MAX_MOUNT_PATH_LENGTH} characters.`,
    );
  }
  if (!mountPath.startsWith("/")) {
    throw new CWSandboxValidationError(`${field} must be an absolute path.`);
  }
  if (posixClean(mountPath) !== mountPath) {
    throw new CWSandboxValidationError(`${field} must be canonical.`);
  }
  if (mountPath === "/") {
    throw new CWSandboxValidationError(`${field} must not be '/'.`);
  }
  for (const reserved of RESERVED_MOUNT_PATH_PREFIXES) {
    if (pathEqualOrUnder(mountPath, reserved)) {
      throw new CWSandboxValidationError(`${field} must not be equal to or under ${reserved}.`);
    }
  }
}

export function validateFileSystemSnapshotOptions(
  options: FileSystemSnapshotOptions | undefined,
  mountedFiles: MountedFiles | undefined,
): void {
  if (options === undefined) {
    return;
  }

  validateMountPath(options.mountPath);
  if (options.size !== undefined && typeof options.size !== "string") {
    throw new CWSandboxValidationError("fileSystemSnapshot.size must be a string.");
  }
  if (
    options.restoreFromSnapshotId !== undefined &&
    typeof options.restoreFromSnapshotId !== "string"
  ) {
    throw new CWSandboxValidationError(
      "fileSystemSnapshot.restoreFromSnapshotId must be a string.",
    );
  }

  const mountPath = options.mountPath;
  for (const file of normalizeMountedFiles(mountedFiles)) {
    const filePath = posixClean(file.path);
    if (filePath === "." || filePath === "") {
      continue;
    }
    if (pathEqualOrUnder(mountPath, filePath) || pathEqualOrUnder(filePath, mountPath)) {
      throw new CWSandboxValidationError(
        `fileSystemSnapshot.mountPath conflicts with mounted file '${file.path}'.`,
      );
    }
  }
}
