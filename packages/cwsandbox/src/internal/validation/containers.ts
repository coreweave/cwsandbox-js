// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../../errors.js";
import type { Container } from "../../public/containers.js";
import type { SandboxRunOptions } from "../../public/sandbox.js";
import { validateMountedFiles } from "../mounted-files.js";
import { validateResources } from "../resources.js";
import { validateSecrets } from "../secrets.js";
import { validateMountPath } from "./file-system-snapshot.js";

const DNS1123_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const DNS1123_LABEL_MAX = 63;

// Platform container names from the multi-container contract.
const RESERVED_CONTAINER_NAMES: ReadonlySet<string> = new Set([
  "cw-object-store-agent",
  "cw-object-store-agent-restore",
  "cws-engine",
  "dns-egress",
  "dns-egress-probe",
]);
const RESERVED_CONTAINER_NAME_PREFIX = "cw-object-store-agent-restore-";

const SINGLE_CONTAINER_OPTIONS = [
  "containerImage",
  "environmentVariables",
  "mountedFiles",
  "resources",
  "secrets",
] as const;

/**
 * Validates `containers` and its exclusivity with the single-container
 * options. `hasCommand` is true when `run()` was given a command.
 */
export function validateContainersOption(options: SandboxRunOptions, hasCommand: boolean): void {
  const containers = options.containers;
  if (containers === undefined) {
    return;
  }
  if (!Array.isArray(containers)) {
    throw new CWSandboxValidationError("containers must be an array.");
  }
  if (containers.length === 0) {
    throw new CWSandboxValidationError("containers cannot be empty");
  }

  for (const [index, container] of containers.entries()) {
    validateContainer(container, `containers[${index}]`);
  }

  const multiple = containers.length > 1;
  if (multiple) {
    if (containers.filter((container) => container.primary === true).length !== 1) {
      throw new CWSandboxValidationError(
        "containers with more than one entry require exactly one primary: true",
      );
    }
    if (containers.some((container) => !container.name)) {
      throw new CWSandboxValidationError(
        "every container must have a name when more than one is specified",
      );
    }
  }

  const seen = new Set<string>();
  for (const container of containers) {
    if (!container.name) {
      continue;
    }
    if (seen.has(container.name)) {
      throw new CWSandboxValidationError(`duplicate container name: '${container.name}'`);
    }
    seen.add(container.name);
  }

  if (multiple) {
    for (const container of containers) {
      if (container.resources === undefined) {
        throw new CWSandboxValidationError(
          `container '${container.name ?? ""}' requires resources when more than one container is specified`,
        );
      }
    }
  }

  const conflicts: string[] = SINGLE_CONTAINER_OPTIONS.filter((key) => options[key] !== undefined);
  if (hasCommand) {
    conflicts.push("command");
  }
  if (conflicts.length > 0) {
    throw new CWSandboxValidationError(
      `containers is mutually exclusive with single-container options (${conflicts.join(", ")})`,
    );
  }
}

function validateContainer(container: Container, field: string): void {
  if (container === null || typeof container !== "object" || Array.isArray(container)) {
    throw new CWSandboxValidationError(`${field} must be an object.`);
  }
  if (typeof container.image !== "string" || container.image.trim() === "") {
    throw new CWSandboxValidationError(`${field}.image cannot be empty`);
  }
  if (container.name !== undefined && container.name !== "") {
    validateContainerName(container.name, `${field}.name`);
  }
  if (container.command !== undefined && typeof container.command !== "string") {
    throw new CWSandboxValidationError(`${field}.command must be a string.`);
  }
  if (container.args !== undefined) {
    if (!Array.isArray(container.args)) {
      throw new CWSandboxValidationError(`${field}.args must be an array of strings.`);
    }
    for (const [index, arg] of container.args.entries()) {
      if (typeof arg !== "string") {
        throw new CWSandboxValidationError(`${field}.args[${index}] must be a string.`);
      }
    }
  }
  if (container.primary !== undefined && typeof container.primary !== "boolean") {
    throw new CWSandboxValidationError(`${field}.primary must be a boolean.`);
  }
  validateMountedFiles(container.mountedFiles);
  validateResources(container.resources);
  validateSecrets(container.secrets, container.environmentVariables);
  validateVolumeMounts(container.volumeMounts, `${field}.volumeMounts`);
}

function validateContainerName(name: unknown, field: string): void {
  if (typeof name !== "string" || name.length > DNS1123_LABEL_MAX || !DNS1123_LABEL.test(name)) {
    throw new CWSandboxValidationError(
      `${field} must be an RFC 1123 DNS label (lowercase alphanumeric and hyphens, at most ${DNS1123_LABEL_MAX} characters), got: ${JSON.stringify(name)}`,
    );
  }
  if (RESERVED_CONTAINER_NAMES.has(name) || name.startsWith(RESERVED_CONTAINER_NAME_PREFIX)) {
    throw new CWSandboxValidationError(`${field} '${name}' is reserved by the platform`);
  }
}

function validateVolumeMounts(mounts: Container["volumeMounts"], field: string): void {
  if (mounts === undefined) {
    return;
  }
  if (!Array.isArray(mounts)) {
    throw new CWSandboxValidationError(`${field} must be an array.`);
  }
  for (const [index, mount] of mounts.entries()) {
    if (mount === null || typeof mount !== "object" || Array.isArray(mount)) {
      throw new CWSandboxValidationError(`${field}[${index}] must be an object.`);
    }
    if (typeof mount.volume !== "string" || mount.volume === "") {
      throw new CWSandboxValidationError(`${field}[${index}].volume cannot be empty`);
    }
    if (typeof mount.mountPath !== "string") {
      throw new CWSandboxValidationError(`${field}[${index}].mountPath is required.`);
    }
    validateMountPath(mount.mountPath, `${field}[${index}].mountPath`);
    if (mount.readOnly !== undefined && typeof mount.readOnly !== "boolean") {
      throw new CWSandboxValidationError(`${field}[${index}].readOnly must be a boolean.`);
    }
    if (mount.subPath !== undefined && typeof mount.subPath !== "string") {
      throw new CWSandboxValidationError(`${field}[${index}].subPath must be a string.`);
    }
  }
}

export function validateContainerTarget(container: string | undefined): void {
  if (container !== undefined && typeof container !== "string") {
    throw new CWSandboxValidationError("container must be a string.");
  }
}
