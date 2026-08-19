// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxValidationError } from "../../errors.js";
import type { ExecOptions, ShellOptions, StartCommandOptions } from "../../public/commands.js";
import type { RequestOptions } from "../../public/common.js";
import type { LogReadOptions, LogStreamOptions } from "../../public/logs.js";
import type {
  DeleteOptions,
  ListSandboxesOptions,
  SandboxRunOptions,
  StopOptions,
  WaitOptions,
} from "../../public/sandbox.js";
import { validateMountedFiles } from "../mounted-files.js";
import { validateNetworkOptions } from "../network.js";
import { rejectUnsupportedFields } from "../removed.js";
import { validateResources } from "../resources.js";
import { validateSecrets } from "../secrets.js";
import { validateAnnotations } from "./annotations.js";
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
}

export function validateShellOptions(options: ShellOptions): void {
  validateRequestOptions(options);
  validateOptionalPositiveInteger(options.cols, "cols");
  validateOptionalPositiveInteger(options.rows, "rows");
}

function validateCommandOptions(options: ExecOptions | StartCommandOptions): void {
  validateRequestOptions(options);
  validateNonNegativeInteger(options.bufferedMaxKiB, "bufferedMaxKiB");
  validateOptionalBoolean(options.check, "check");
  validateOptionalNonBlankString(options.cwd, "cwd");
  if ("stdin" in options) {
    validateOptionalBoolean(options.stdin, "stdin");
  }
}

export function validateSandboxRunOptions(options: SandboxRunOptions): void {
  rejectUnsupportedFields(options, ["ports", "profileIds", "profileNames"]);
  validateRequestOptions(options);
  validateAnnotations(options.annotations);
  validateNonNegativeFinite(options.maxLifetimeSeconds, "maxLifetimeSeconds");
  validateMountedFiles(options.mountedFiles);
  validateNetworkOptions(options.services, options.network);
  validateResources(options.resources);
  validateSecrets(options.secrets, options.environmentVariables);
  validateUniqueStringList(options.runnerIds, "runnerIds");
  validateTags(options.tags);
  validateOptionalBoolean(options.waitUntilRunning, "waitUntilRunning");
}

export function validateWaitOptions(options: WaitOptions): void {
  validateRequestOptions(options);
}

export function validateStopOptions(options: StopOptions): void {
  rejectUnsupportedFields(options, ["snapshotOnStop"]);
  validateRequestOptions(options);
  validateNonNegativeInteger(options.gracefulShutdownSeconds, "gracefulShutdownSeconds");
  validateOptionalBoolean(options.missingOk, "missingOk");
}

export function validateDeleteOptions(options: DeleteOptions): void {
  validateRequestOptions(options);
  validateOptionalBoolean(options.missingOk, "missingOk");
}

export function validateListSandboxesOptions(options: ListSandboxesOptions): void {
  rejectUnsupportedFields(options, ["includeStopped", "profileIds", "profileNames"]);
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
