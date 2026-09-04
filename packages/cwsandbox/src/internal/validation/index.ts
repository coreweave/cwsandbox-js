// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../../errors.js";
import type { ExecOptions, ShellOptions, StartCommandOptions } from "../../public/commands.js";
import type { RequestOptions } from "../../public/common.js";
import type { DataPlaneMode } from "../../public/data-plane.js";
import type { LogReadOptions, LogStreamOptions } from "../../public/logs.js";
import type {
  DeleteOptions,
  DeleteSnapshotOptions,
  ListSandboxesOptions,
  ListSnapshotsOptions,
  SandboxFileContents,
  SandboxRunFromFileOptions,
  SandboxRunFromTemplateOptions,
  SandboxRunOptions,
  StopOptions,
  WaitOptions,
} from "../../public/sandbox.js";
import { normalizeCommand } from "../commands.js";
import { validateFromFileContentsInput } from "../from-file-contents.js";
import { validateMountedFiles } from "../mounted-files.js";
import { validateNetworkOptions } from "../network.js";
import { validateResources } from "../resources.js";
import { validateSecrets } from "../secrets.js";
import { validateAnnotations } from "./annotations.js";
import { validateSandboxVolumeCreateOptions } from "./file-system-snapshot.js";
import { validateObjectStorageAccess } from "./object-storage.js";
import { validateUniqueStringList } from "./string-list.js";
import { validateTags } from "./tags.js";

export function validateRequestOptions(options: RequestOptions): void {
  validateNonNegativeFinite(options.timeoutMs, "timeoutMs");
}

export function validateExecOptions(options: ExecOptions): void {
  validateCommandOptions(options);
}

export function validateStartCommandOptions(options: StartCommandOptions): void {
  validateCommandOptions(options);
  validateNonNegativeInteger(options.bufferedMaxKiB, "bufferedMaxKiB");
}

export function validateShellOptions(options: ShellOptions): void {
  validateRequestOptions(options);
  validateOptionalPositiveInteger(options.cols, "cols");
  validateOptionalPositiveInteger(options.rows, "rows");
}

function validateCommandOptions(options: ExecOptions | StartCommandOptions): void {
  validateRequestOptions(options);
  validateOptionalBoolean(options.check, "check");
  validateOptionalNonBlankString(options.cwd, "cwd");
  if ("stdin" in options) {
    validateOptionalBoolean(options.stdin, "stdin");
  }
}

const REMOVED_CREATE_KEYS = [
  "maxTimeoutSeconds",
  "ports",
  "profileIds",
  "profileNames",
  "s3Mount",
] as const;

export function validateSandboxRunOptions(options: SandboxRunOptions): void {
  rejectRemovedKeys(options, REMOVED_CREATE_KEYS);
  if (options.network !== undefined) {
    rejectRemovedKeys(options.network, ["egressMode", "exposedPorts", "ingressMode"]);
  }
  validateRequestOptions(options);
  validateAnnotations(options.annotations);
  validateNonNegativeFinite(options.maxLifetimeSeconds, "maxLifetimeSeconds");
  validateMountedFiles(options.mountedFiles);
  validateSandboxVolumeCreateOptions(options);
  validateObjectStorageAccess(options.objectStorageAccess);
  validateNetworkOptions(options.services, options.network);
  validateResources(options.resources);
  validateSecrets(options.secrets, options.environmentVariables);
  validateUniqueStringList(options.runnerIds, "runnerIds");
  validateTags(options.tags);
  validateOptionalBoolean(options.waitUntilRunning, "waitUntilRunning");
  validateDataPlaneMode(options.dataPlaneMode);
}

const CONTAINER_OVERRIDE_FIELDS = [
  "command",
  "environmentVariables",
  "fileSystemSnapshot",
  "mountedFiles",
  "resources",
  "secrets",
  "volumes",
] as const;

const CONTAINER_IMAGE_REQUIRED_MESSAGE =
  "containerImage is required when overriding template container fields because container overrides replace the entire container list.";

export function validateSandboxRunFromTemplateOptions(
  templateId: string,
  options: SandboxRunFromTemplateOptions,
): void {
  if (typeof templateId !== "string" || templateId.trim() === "") {
    throw new CWSandboxValidationError("templateId must not be empty.");
  }
  if (!isPlainRecordValue(options)) {
    throw new CWSandboxValidationError("options must be an object");
  }
  rejectUnsupportedTemplateKeys(options);
  rejectRemovedKeys(options, REMOVED_CREATE_KEYS);
  validateTemplateOptionShapes(options);
  if (options.network !== undefined) {
    rejectRemovedKeys(options.network, ["egressMode", "exposedPorts", "ingressMode"]);
  }
  validateRequestOptions(options);
  if (options.containerImage === undefined) {
    for (const field of CONTAINER_OVERRIDE_FIELDS) {
      if (isContainerOverride(options, field)) {
        throw new CWSandboxValidationError(CONTAINER_IMAGE_REQUIRED_MESSAGE);
      }
    }
  } else if (typeof options.containerImage !== "string" || options.containerImage.trim() === "") {
    throw new CWSandboxValidationError("containerImage must not be empty.");
  }
  if (options.command !== undefined) {
    normalizeCommand(options.command);
  }
  validateAnnotations(options.annotations);
  validateNonNegativeFinite(options.maxLifetimeSeconds, "maxLifetimeSeconds");
  validateMountedFiles(options.mountedFiles);
  validateSandboxVolumeCreateOptions(options);
  validateNetworkOptions(options.services, options.network);
  validateResources(options.resources);
  validateSecrets(options.secrets, options.environmentVariables);
  validateUniqueStringList(options.runnerIds, "runnerIds");
  validateTags(options.tags);
  validateOptionalBoolean(options.waitUntilRunning, "waitUntilRunning");
  validateDataPlaneMode(options.dataPlaneMode);
}

const FROM_FILE_UNSUPPORTED_KEYS = [
  "buildContexts",
  "command",
  "containerImage",
  "containers",
  "environmentVariables",
  "fileSystemSnapshot",
  "imagePullCredentials",
  "instanceType",
  "mountedFiles",
  "networkIds",
  "resources",
  "runtimeClass",
  "secrets",
  "securityContext",
  "services",
  "templateId",
  "volumes",
  "workingDir",
] as const;

export function validateSandboxRunFromFileOptions(
  contents: SandboxFileContents,
  options: SandboxRunFromFileOptions,
): void {
  validateFromFileContentsInput(contents);
  if (!isPlainRecordValue(options)) {
    throw new CWSandboxValidationError("options must be an object");
  }
  rejectUnsupportedFromFileKeys(options);
  rejectRemovedKeys(options, REMOVED_CREATE_KEYS);
  if (options.network !== undefined) {
    rejectRemovedKeys(options.network, ["egressMode", "exposedPorts", "ingressMode"]);
  }
  validateFromFileOptionShapes(options);
  if (typeof options.primaryService !== "string" || options.primaryService.trim() === "") {
    throw new CWSandboxValidationError("primaryService must not be empty.");
  }
  if (options.fileType !== undefined && options.fileType !== "compose") {
    throw new CWSandboxValidationError('fileType must be "compose".');
  }
  validateRequestOptions(options);
  validateAnnotations(options.annotations);
  validateNonNegativeFinite(options.maxLifetimeSeconds, "maxLifetimeSeconds");
  validateObjectStorageAccess(options.objectStorageAccess);
  validateNetworkOptions(undefined, options.network);
  rejectGpuResources(options.defaultResources, "defaultResources");
  validateResources(options.defaultResources);
  validateUniqueStringList(options.runnerIds, "runnerIds");
  validateTags(options.tags);
  validateOptionalBoolean(options.waitUntilRunning, "waitUntilRunning");
  validateDataPlaneMode(options.dataPlaneMode);
}

function rejectUnsupportedFromFileKeys(options: object): void {
  const record = options as Record<string, unknown>;
  for (const key of FROM_FILE_UNSUPPORTED_KEYS) {
    if (record[key] !== undefined) {
      throw new CWSandboxValidationError(`${key} is not supported with from-file sandboxes.`);
    }
  }
}

function validateFromFileOptionShapes(options: SandboxRunFromFileOptions): void {
  requirePlainRecordIfPresent(options.annotations, "annotations");
  requirePlainRecordIfPresent(options.imageOverrides, "imageOverrides");
  requirePlainRecordIfPresent(options.network, "network");
  requirePlainRecordIfPresent(options.objectStorageAccess, "objectStorageAccess");
  requirePlainRecordIfPresent(options.defaultResources, "defaultResources");
  requireArrayIfPresent(options.runnerIds, "runnerIds");
  requireArrayIfPresent(options.tags, "tags");
  requireStringIfPresent(options.primaryService, "primaryService");
  requireStringIfPresent(options.fileType, "fileType");

  if (options.imageOverrides !== undefined) {
    for (const [key, value] of Object.entries(options.imageOverrides)) {
      if (key === "") {
        throw new CWSandboxValidationError("imageOverrides must not contain empty keys");
      }
      if (typeof value !== "string" || value === "") {
        throw new CWSandboxValidationError(`imageOverrides["${key}"] must be a non-empty string`);
      }
    }
  }

  if (options.defaultResources !== undefined) {
    const resources = options.defaultResources as Record<string, unknown>;
    requireStringIfPresent(resources["cpu"], "defaultResources.cpu");
    requireStringIfPresent(resources["memory"], "defaultResources.memory");
    if (resources["requests"] !== undefined) {
      requirePlainRecord(resources["requests"], "defaultResources.requests");
      requireStringIfPresent(resources["requests"]["cpu"], "defaultResources.requests.cpu");
      requireStringIfPresent(resources["requests"]["memory"], "defaultResources.requests.memory");
    }
    if (resources["limits"] !== undefined) {
      requirePlainRecord(resources["limits"], "defaultResources.limits");
      requireStringIfPresent(resources["limits"]["cpu"], "defaultResources.limits.cpu");
      requireStringIfPresent(resources["limits"]["memory"], "defaultResources.limits.memory");
    }
  }
}

function rejectGpuResources(resources: unknown, field: string): void {
  if (resources === undefined || resources === null || typeof resources !== "object") {
    return;
  }
  const record = resources as Record<string, unknown>;
  if (record["gpu"] !== undefined) {
    throw new CWSandboxValidationError(`${field} must not set GPU`);
  }
  if (record["requests"] !== undefined) {
    rejectGpuResources(record["requests"], `${field}.requests`);
  }
  if (record["limits"] !== undefined) {
    rejectGpuResources(record["limits"], `${field}.limits`);
  }
}

export function validateDataPlaneMode(mode: DataPlaneMode | undefined): void {
  if (mode !== undefined && mode !== "auto" && mode !== "direct" && mode !== "gateway") {
    throw new CWSandboxValidationError("dataPlaneMode must be 'auto', 'direct', or 'gateway'.");
  }
}

export function validateWaitOptions(options: WaitOptions): void {
  validateRequestOptions(options);
}

export function validateStopOptions(options: StopOptions): void {
  if ((options as Record<string, unknown>)["snapshotOnStop"] !== undefined) {
    throw new CWSandboxValidationError(
      "snapshotOnStop is not supported; use sandbox.snapshot() to capture a file-system snapshot",
    );
  }
  validateRequestOptions(options);
  validateNonNegativeInteger(options.gracefulShutdownSeconds, "gracefulShutdownSeconds");
  validateOptionalBoolean(options.missingOk, "missingOk");
}

export function validateDeleteOptions(options: DeleteOptions): void {
  validateRequestOptions(options);
  validateOptionalBoolean(options.missingOk, "missingOk");
}

export function validateDeleteSnapshotOptions(options: DeleteSnapshotOptions): void {
  validateRequestOptions(options);
  validateOptionalBoolean(options.missingOk, "missingOk");
}

export function validateSnapshotId(snapshotId: string): void {
  if (typeof snapshotId !== "string" || snapshotId.trim() === "") {
    throw new CWSandboxValidationError("snapshotId must not be empty.");
  }
}

const FILE_SYSTEM_SNAPSHOT_STATES: ReadonlySet<string> = new Set([
  "creating",
  "ready",
  "failed",
  "deleting",
  "unspecified",
]);

export function validateListSnapshotsOptions(options: ListSnapshotsOptions): void {
  rejectRemovedKeys(options, ["pageToken", "pageSize"]);
  validateRequestOptions(options);
  validateOptionalNonBlankString(options.sourceSandboxId, "sourceSandboxId");
  if (options.state !== undefined && !FILE_SYSTEM_SNAPSHOT_STATES.has(options.state)) {
    throw new CWSandboxValidationError("state must be a file-system snapshot state.");
  }
}

export function validateListSandboxesOptions(options: ListSandboxesOptions): void {
  rejectRemovedKeys(options, ["includeStopped", "profileIds", "profileNames"]);
  validateRequestOptions(options);
  validateNonNegativeInteger(options.pageSize, "pageSize");
  validateOptionalBoolean(options.showTerminated, "showTerminated");
  validateUniqueStringList(options.runnerIds, "runnerIds");
  validateTags(options.tags);
}

export function validateLogReadOptions(options: LogReadOptions): void {
  validateLogStreamOptions(options);

  if ((options as LogStreamOptions).follow === true) {
    throw new CWSandboxValidationError("logs.read does not support follow: true.");
  }
}

export function validateLogStreamOptions(options: LogStreamOptions): void {
  validateRequestOptions(options);
  validateNonNegativeInteger(options.tailLines, "tailLines");
  validateOptionalBoolean(options.follow, "follow");
  validateOptionalBoolean(options.timestamps, "timestamps");
  validateSinceTime(options.sinceTime);
  validateLogResume(options);
}

function rejectRemovedKeys(source: object, keys: readonly string[]): void {
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) {
      throw new CWSandboxValidationError(`${key} is not supported in v1`);
    }
  }
}

function isContainerOverride(
  options: SandboxRunFromTemplateOptions,
  field: (typeof CONTAINER_OVERRIDE_FIELDS)[number],
): boolean {
  const value = options[field];
  if (value === undefined) {
    return false;
  }
  if (field === "environmentVariables") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function validateTemplateOptionShapes(options: SandboxRunFromTemplateOptions): void {
  requirePlainRecordIfPresent(options.annotations, "annotations");
  requirePlainRecordIfPresent(options.environmentVariables, "environmentVariables");
  requirePlainRecordIfPresent(options.fileSystemSnapshot, "fileSystemSnapshot");
  requirePlainRecordIfPresent(options.network, "network");
  requirePlainRecordIfPresent(options.resources, "resources");
  requireArrayIfPresent(options.command, "command");
  requireArrayIfPresent(options.runnerIds, "runnerIds");
  requireArrayIfPresent(options.secrets, "secrets");
  requireArrayIfPresent(options.services, "services");
  requireArrayIfPresent(options.tags, "tags");
  requireArrayIfPresent(options.volumes, "volumes");

  if (options.command !== undefined) {
    if (
      options.command.length === 0 ||
      !options.command.every((item) => typeof item === "string")
    ) {
      throw new CWSandboxValidationError("command must be a non-empty array of strings");
    }
  }

  if (options.environmentVariables !== undefined) {
    for (const [key, value] of Object.entries(options.environmentVariables)) {
      if (typeof value !== "string") {
        throw new CWSandboxValidationError(`environmentVariables["${key}"] must be a string`);
      }
    }
  }

  if (options.fileSystemSnapshot !== undefined) {
    const snapshot = options.fileSystemSnapshot as unknown as Record<string, unknown>;
    if (typeof snapshot["mountPath"] !== "string") {
      throw new CWSandboxValidationError("fileSystemSnapshot.mountPath must be a string");
    }
    requireStringIfPresent(snapshot["size"], "fileSystemSnapshot.size");
    requireStringIfPresent(
      snapshot["restoreFromSnapshotId"],
      "fileSystemSnapshot.restoreFromSnapshotId",
    );
  }

  if (options.resources !== undefined) {
    const resources = options.resources as Record<string, unknown>;
    requireStringIfPresent(resources["cpu"], "resources.cpu");
    requireStringIfPresent(resources["memory"], "resources.memory");
    if (resources["requests"] !== undefined) {
      requirePlainRecord(resources["requests"], "resources.requests");
      requireStringIfPresent(resources["requests"]["cpu"], "resources.requests.cpu");
      requireStringIfPresent(resources["requests"]["memory"], "resources.requests.memory");
    }
    if (resources["limits"] !== undefined) {
      requirePlainRecord(resources["limits"], "resources.limits");
      requireStringIfPresent(resources["limits"]["cpu"], "resources.limits.cpu");
      requireStringIfPresent(resources["limits"]["memory"], "resources.limits.memory");
    }
  }

  validateMountedFilesShape(options.mountedFiles);
  requireArrayOfRecordsIfPresent(options.secrets, "secrets");
  requireArrayOfRecordsIfPresent(options.services, "services");
  requireArrayOfRecordsIfPresent(options.volumes, "volumes");
  validateSecretsShape(options.secrets);
  validateServicesShape(options.services);
  validateVolumesShape(options.volumes);
}

function validateMountedFilesShape(mountedFiles: unknown): void {
  if (mountedFiles === undefined) {
    return;
  }

  if (Array.isArray(mountedFiles)) {
    for (const [index, entry] of mountedFiles.entries()) {
      if (!isPlainRecord(entry)) {
        throw new CWSandboxValidationError(`mountedFiles[${index}] must be an object`);
      }
      if (typeof entry["path"] !== "string") {
        throw new CWSandboxValidationError(`mountedFiles[${index}].path must be a string`);
      }
      if (typeof entry["content"] !== "string" && !(entry["content"] instanceof Uint8Array)) {
        throw new CWSandboxValidationError(
          `mountedFiles[${index}].content must be a string or Uint8Array`,
        );
      }
    }
    return;
  }

  if (!isPlainRecord(mountedFiles)) {
    throw new CWSandboxValidationError("mountedFiles must be an object or an array");
  }

  for (const [path, content] of Object.entries(mountedFiles)) {
    if (typeof content !== "string" && !(content instanceof Uint8Array)) {
      throw new CWSandboxValidationError(`mountedFiles["${path}"] must be a string or Uint8Array`);
    }
  }
}

function isPlainRecordValue(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isPlainRecordValue(value);
}

function requireStringIfPresent(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new CWSandboxValidationError(`${name} must be a string`);
  }
}

function requireNumberIfPresent(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "number") {
    throw new CWSandboxValidationError(`${name} must be a number`);
  }
}

function validateSecretsShape(secrets: unknown): void {
  if (secrets === undefined) {
    return;
  }
  for (const [index, secret] of (secrets as readonly Record<string, unknown>[]).entries()) {
    requireStringIfPresent(secret["field"], `secrets[${index}].field`);
  }
}

function validateServicesShape(services: unknown): void {
  if (services === undefined) {
    return;
  }
  for (const [index, service] of (services as readonly Record<string, unknown>[]).entries()) {
    if (typeof service["port"] !== "number") {
      throw new CWSandboxValidationError(`services[${index}].port must be a number`);
    }
    requireStringIfPresent(service["name"], `services[${index}].name`);
    requireStringIfPresent(service["protocol"], `services[${index}].protocol`);
    requireStringIfPresent(service["visibility"], `services[${index}].visibility`);
    if (service["endpoint"] === undefined) {
      continue;
    }
    requirePlainRecord(service["endpoint"], `services[${index}].endpoint`);
    requireStringIfPresent(service["endpoint"]["kind"], `services[${index}].endpoint.kind`);
    requireStringIfPresent(service["endpoint"]["auth"], `services[${index}].endpoint.auth`);
    requireNumberIfPresent(
      service["endpoint"]["requestTimeoutSeconds"],
      `services[${index}].endpoint.requestTimeoutSeconds`,
    );
  }
}

function validateVolumesShape(volumes: unknown): void {
  if (volumes === undefined) {
    return;
  }
  for (const [index, volume] of (volumes as readonly Record<string, unknown>[]).entries()) {
    if (typeof volume["name"] !== "string") {
      throw new CWSandboxValidationError(`volumes[${index}].name must be a string`);
    }
    if (typeof volume["mountPath"] !== "string") {
      throw new CWSandboxValidationError(`volumes[${index}].mountPath must be a string`);
    }
    requireStringIfPresent(volume["size"], `volumes[${index}].size`);
    requireStringIfPresent(
      volume["restoreFromSnapshotId"],
      `volumes[${index}].restoreFromSnapshotId`,
    );
  }
}

function requirePlainRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new CWSandboxValidationError(`${name} must be an object`);
  }
}

function requirePlainRecordIfPresent(value: unknown, name: string): void {
  if (value !== undefined) {
    requirePlainRecord(value, name);
  }
}

function requireArrayIfPresent(value: unknown, name: string): void {
  if (value !== undefined && !Array.isArray(value)) {
    throw new CWSandboxValidationError(`${name} must be an array`);
  }
}

function requireArrayOfRecordsIfPresent(value: unknown, name: string): void {
  if (value === undefined) {
    return;
  }
  requireArrayIfPresent(value, name);
  for (const [index, entry] of (value as readonly unknown[]).entries()) {
    if (!isPlainRecord(entry)) {
      throw new CWSandboxValidationError(`${name}[${index}] must be an object`);
    }
  }
}

function rejectUnsupportedTemplateKeys(options: object): void {
  const record = options as Record<string, unknown>;
  if (record["imagePullCredentials"] !== undefined) {
    throw new CWSandboxValidationError(
      "imagePullCredentials is not supported with template sandboxes.",
    );
  }
  if (record["objectStorageAccess"] !== undefined) {
    throw new CWSandboxValidationError(
      "objectStorageAccess is not supported with template sandboxes.",
    );
  }
}

function validateNonNegativeFinite(value: number | undefined, name: string): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new CWSandboxValidationError(`${name} must be a finite non-negative number.`);
  }
}

function validateNonNegativeInteger(value: number | undefined, name: string): void {
  validateNonNegativeFinite(value, name);

  if (value !== undefined && !Number.isInteger(value)) {
    throw new CWSandboxValidationError(`${name} must be an integer.`);
  }
}

function validateOptionalPositiveInteger(value: number | undefined, name: string): void {
  validateNonNegativeInteger(value, name);

  if (value !== undefined && value <= 0) {
    throw new CWSandboxValidationError(`${name} must be a positive integer.`);
  }
}

function validateOptionalNonBlankString(value: string | undefined, name: string): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new CWSandboxValidationError(`${name} must not be empty.`);
  }
}

function validateOptionalBoolean(value: boolean | undefined, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new CWSandboxValidationError(`${name} must be a boolean.`);
  }
}

function validateSinceTime(value: Date | string | undefined): void {
  if (value === undefined) {
    return;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CWSandboxValidationError("sinceTime must be a valid Date.");
    }
    return;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new CWSandboxValidationError("sinceTime must be a Date or timestamp string.");
  }

  if (Number.isNaN(new Date(value).getTime())) {
    throw new CWSandboxValidationError("sinceTime must be a valid timestamp string.");
  }
}

function validateLogResume(options: LogStreamOptions): void {
  const resume = options.resume;
  if (resume === undefined) {
    return;
  }

  if (options.follow !== true) {
    throw new CWSandboxValidationError("resume requires follow: true.");
  }

  validateOptionalNonBlankString(resume.sessionId, "resume.sessionId");
  validateResumeOffset(resume.offset);

  if (
    options.tailLines !== undefined ||
    options.sinceTime !== undefined ||
    options.timestamps === true
  ) {
    throw new CWSandboxValidationError(
      "resume cannot be combined with tailLines, sinceTime, or timestamps.",
    );
  }
}

function validateResumeOffset(value: bigint | number | string): void {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new CWSandboxValidationError("resume.offset must be non-negative.");
    }
    return;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CWSandboxValidationError("resume.offset must be a safe non-negative integer.");
    }
    return;
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new CWSandboxValidationError("resume.offset must be a non-negative integer.");
  }
}
