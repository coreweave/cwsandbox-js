// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import path from "node:path";

import { DEFAULT_SCRATCH_VOLUME_NAME } from "../../defaults.js";
import { CWSandboxValidationError } from "../../errors.js";
import type { MountedFiles } from "../../public/files.js";
import type {
  FileSystemSnapshotOptions,
  SandboxRunOptions,
  ScratchVolumeOptions,
} from "../../public/sandbox.js";
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

function rejectMountedFileConflicts(
  mountPath: string,
  mountedFiles: MountedFiles | undefined,
  field: string,
): void {
  for (const file of normalizeMountedFiles(mountedFiles)) {
    const filePath = posixClean(file.path);
    if (filePath === "." || filePath === "") {
      continue;
    }
    if (pathEqualOrUnder(mountPath, filePath) || pathEqualOrUnder(filePath, mountPath)) {
      throw new CWSandboxValidationError(`${field} conflicts with mounted file '${file.path}'.`);
    }
  }
}

function validateOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new CWSandboxValidationError(`${field} must be a string.`);
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
  validateOptionalString(options.size, "fileSystemSnapshot.size");
  validateOptionalString(options.restoreFromSnapshotId, "fileSystemSnapshot.restoreFromSnapshotId");
  rejectMountedFileConflicts(options.mountPath, mountedFiles, "fileSystemSnapshot.mountPath");
}

export function validateScratchVolumeOptions(
  volumes: readonly ScratchVolumeOptions[] | undefined,
  mountedFiles: MountedFiles | undefined,
): void {
  if (volumes === undefined) {
    return;
  }

  if (!Array.isArray(volumes)) {
    throw new CWSandboxValidationError("volumes must be an array.");
  }
  if (volumes.length === 0) {
    throw new CWSandboxValidationError("volumes must not be empty.");
  }

  const names = new Set<string>();
  const mountPaths = new Set<string>();
  for (const [index, volume] of volumes.entries()) {
    const nameField = `volumes[${index}].name`;
    const mountField = `volumes[${index}].mountPath`;
    if (typeof volume.name !== "string" || volume.name === "") {
      throw new CWSandboxValidationError(`${nameField} is required.`);
    }
    if (names.has(volume.name)) {
      throw new CWSandboxValidationError(`${nameField} duplicates '${volume.name}'.`);
    }
    names.add(volume.name);

    validateMountPath(volume.mountPath, mountField);
    if (mountPaths.has(volume.mountPath)) {
      throw new CWSandboxValidationError(`${mountField} duplicates '${volume.mountPath}'.`);
    }
    mountPaths.add(volume.mountPath);

    validateOptionalString(volume.size, `volumes[${index}].size`);
    validateOptionalString(volume.restoreFromSnapshotId, `volumes[${index}].restoreFromSnapshotId`);
    rejectMountedFileConflicts(volume.mountPath, mountedFiles, mountField);
  }
}

export function validateSandboxVolumeCreateOptions(options: SandboxRunOptions): void {
  if (options.fileSystemSnapshot !== undefined && options.volumes !== undefined) {
    throw new CWSandboxValidationError("fileSystemSnapshot and volumes cannot be used together");
  }
  validateFileSystemSnapshotOptions(options.fileSystemSnapshot, options.mountedFiles);
  validateScratchVolumeOptions(options.volumes, options.mountedFiles);
}

/** Scratch names known from this-process create. Undefined when neither option is set. */
export function scratchVolumeNamesFromRunOptions(
  options: SandboxRunOptions,
): readonly string[] | undefined {
  if (options.volumes !== undefined) {
    return options.volumes.map((volume) => volume.name);
  }
  if (options.fileSystemSnapshot !== undefined) {
    return [DEFAULT_SCRATCH_VOLUME_NAME];
  }
  return undefined;
}
