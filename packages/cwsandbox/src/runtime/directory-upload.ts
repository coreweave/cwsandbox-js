// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import {
  CWSandboxAuthenticationError,
  CWSandboxExecutionError,
  CWSandboxNotFoundError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxValidationError,
} from "../errors.js";
import {
  EXIT_ARCHIVE_CHECKSUM,
  EXIT_MISSING_PART,
  EXIT_MISSING_TOOLS,
  EXIT_PART_CHECKSUM,
  EXIT_PART_SIZE,
  FINAL_SCRIPT,
  FINAL_TIMEOUT_MS,
  PART_ATTEMPT_TIMEOUT_MS,
  PART_MAX_ATTEMPTS,
  PART_NAME_RE,
  PART_RETRY_DELAYS_MS,
  PART_SCRIPT,
  PREFLIGHT_SCRIPT,
  PREFLIGHT_TIMEOUT_MS,
  STAGING_PREFIX,
  type ArchivePart,
  iterParts,
  normalizeExcludes,
  normalizeRemotePath,
  requiredTools,
  scanDirectory,
  uploadError,
} from "../internal/directory-upload.js";
import { validateFileOptions } from "../internal/validation/index.js";
import type { DirectoryUploadOptions, DirectoryUploadResult } from "../public/files.js";
import type { FileTransfer } from "./file-transfer.js";

const SANDBOX_NOT_RUNNING = "CWSANDBOX_SANDBOX_NOT_RUNNING";

/** Whether a failed part attempt is worth sending again (Python parity). */
export function isRetryablePartError(error: unknown): boolean {
  if (error instanceof CWSandboxNotFoundError || error instanceof CWSandboxAuthenticationError) {
    return false;
  }
  if (error instanceof CWSandboxTransportError) {
    return error.reason !== SANDBOX_NOT_RUNNING;
  }
  return error instanceof CWSandboxExecutionError;
}

function timeoutError(remotePath: string): CWSandboxTimeoutError {
  return new CWSandboxTimeoutError(
    `Upload directory to '${remotePath}' timed out; staged parts are kept and the next call resumes`,
    { operation: "Upload directory" },
  );
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function uploadDirectory(
  fileTransfer: FileTransfer,
  localPath: string,
  remotePath: string,
  options: DirectoryUploadOptions = {},
): Promise<DirectoryUploadResult> {
  validateFileOptions(options);
  if (typeof localPath !== "string" || localPath === "") {
    throw new CWSandboxValidationError("uploadDirectory localPath must be a non-empty string.");
  }
  const destination = normalizeRemotePath(remotePath);
  const patterns = normalizeExcludes(options.exclude);
  const compress = options.compress ?? true;
  let info;
  try {
    info = await stat(localPath);
  } catch {
    throw new CWSandboxValidationError(`uploadDirectory localPath does not exist: ${localPath}`);
  }
  if (!info.isDirectory()) {
    throw new CWSandboxValidationError(
      `uploadDirectory localPath is not a directory: ${localPath}`,
    );
  }

  const { signal } = options;
  const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  const stepTimeout = (cap: number): number => {
    if (deadline === undefined) {
      return cap;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw timeoutError(destination);
    }
    return Math.min(cap, remaining);
  };
  const run = (
    script: string,
    argv0: string,
    args: readonly string[],
    cap: number,
    stdin?: Uint8Array,
  ) =>
    fileTransfer.runScript(["/bin/sh", "-c", script, argv0, ...args], {
      timeoutMs: stepTimeout(cap),
      ...(options.container === undefined ? {} : { container: options.container }),
      ...(signal === undefined ? {} : { signal }),
      ...(stdin === undefined ? {} : { stdin }),
    });
  const sandboxId = fileTransfer.id;

  const plan = await scanDirectory(localPath, patterns, compress, destination);
  const stage = `${destination}/${STAGING_PREFIX}${plan.key}`;

  const preflight = await run(
    PREFLIGHT_SCRIPT,
    "cwsandbox-upload-preflight",
    [destination, stage, ...requiredTools(compress)],
    PREFLIGHT_TIMEOUT_MS,
  );
  if (preflight.exitCode === EXIT_MISSING_TOOLS) {
    const missing = preflight.stderr.slice(preflight.stderr.indexOf(":") + 1).trim();
    const hint = missing === "gzip" ? " Pass compress: false if only gzip is missing." : "";
    throw uploadError(
      `Cannot upload to '${destination}': the sandbox image is missing required tools: ${missing}.${hint}`,
      "preflight",
      destination,
      { missing_tools: missing },
      sandboxId,
    );
  }
  if (preflight.exitCode !== 0) {
    throw uploadError(
      `Cannot upload to '${destination}': ${preflight.stderr || `preflight exited ${preflight.exitCode}`}`,
      "preflight",
      destination,
      { exit_code: String(preflight.exitCode) },
      sandboxId,
    );
  }
  const committed = new Set(
    preflight.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => PART_NAME_RE.test(line)),
  );

  const sendPart = async (part: ArchivePart): Promise<void> => {
    for (let attempt = 0; attempt < PART_MAX_ATTEMPTS; attempt += 1) {
      const lastAttempt = attempt === PART_MAX_ATTEMPTS - 1;
      let result;
      try {
        result = await run(
          PART_SCRIPT,
          "cwsandbox-upload-part",
          [stage, String(part.index).padStart(6, "0"), String(part.data.byteLength), part.sha256],
          PART_ATTEMPT_TIMEOUT_MS,
          part.data,
        );
      } catch (error) {
        if (lastAttempt || !isRetryablePartError(error)) {
          throw error;
        }
      }
      if (result?.exitCode === 0) {
        return;
      }
      if (result !== undefined) {
        const retryable =
          result.exitCode === EXIT_PART_SIZE || result.exitCode === EXIT_PART_CHECKSUM;
        if (lastAttempt || !retryable) {
          throw uploadError(
            `Sending part ${part.index} of the upload to '${destination}' failed: ` +
              `${result.stderr || `exit status ${result.exitCode}`}`,
            "transfer",
            destination,
            { exit_code: String(result.exitCode), part: String(part.index) },
            sandboxId,
          );
        }
      }
      const delay = PART_RETRY_DELAYS_MS[attempt] as number;
      if (stepTimeout(delay) < delay) {
        throw timeoutError(destination);
      }
      await sleep(delay, signal);
    }
  };

  const archiveHash = createHash("sha256");
  let archiveBytes = 0;
  let resumedBytes = 0;
  const names: string[] = [];
  for await (const part of iterParts(plan, compress, destination)) {
    signal?.throwIfAborted();
    archiveHash.update(part.data);
    archiveBytes += part.data.byteLength;
    names.push(part.name);
    if (committed.has(part.name)) {
      resumedBytes += part.data.byteLength;
    } else {
      await sendPart(part);
    }
    options.onProgress?.({ bytesDone: part.sourceBytesDone, bytesTotal: plan.totalBytes });
  }

  const digest = archiveHash.digest("hex");
  const final = await run(
    FINAL_SCRIPT,
    "cwsandbox-upload-final",
    [destination, stage, digest, compress ? "z" : "-", ...names],
    FINAL_TIMEOUT_MS,
  );
  if (final.exitCode === EXIT_MISSING_PART || final.exitCode === EXIT_ARCHIVE_CHECKSUM) {
    throw uploadError(
      `Upload to '${destination}' failed verification: ${final.stderr}. '${destination}' was not changed.`,
      "verify",
      destination,
      { exit_code: String(final.exitCode) },
      sandboxId,
    );
  }
  if (final.exitCode !== 0) {
    throw uploadError(
      `Extracting the upload into '${destination}' failed: ` +
        `${final.stderr || `exit status ${final.exitCode}`}. '${destination}' may be partly ` +
        "updated; staged parts are kept, so calling again only re-extracts.",
      "extract",
      destination,
      { exit_code: String(final.exitCode) },
      sandboxId,
    );
  }
  const count = (kind: string) => plan.entries.filter((entry) => entry.kind === kind).length;
  return {
    archiveBytes,
    bytes: plan.totalBytes,
    directories: count("d"),
    files: count("f"),
    resumedBytes,
    sha256: digest,
    skipped: [...plan.skipped],
    symlinks: count("l"),
  };
}
