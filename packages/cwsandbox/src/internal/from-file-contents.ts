// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { readFile, stat } from "node:fs/promises";

import { CWSandboxValidationError } from "../errors.js";

/** Raw Compose YAML cap for create-from-file. The API also enforces this. */
export const CREATE_FROM_FILE_CONTENTS_MAX_BYTES = 256 * 1024;

export function validateFromFileContentsInput(
  contents: unknown,
): asserts contents is string | Uint8Array {
  if (contents instanceof Uint8Array) {
    return;
  }
  if (typeof contents === "string" && contents.trim() !== "") {
    return;
  }
  throw new CWSandboxValidationError(
    "contents must be a non-empty filesystem path or a Uint8Array of file bytes.",
  );
}

function validateFromFileContentsSize(contents: Uint8Array): void {
  if (contents.byteLength > CREATE_FROM_FILE_CONTENTS_MAX_BYTES) {
    throw new CWSandboxValidationError(
      `contents exceeds ${String(CREATE_FROM_FILE_CONTENTS_MAX_BYTES)} bytes (256 KiB).`,
    );
  }
}

/** Reads path bytes or returns the given `Uint8Array`. Do not log `contents`. */
export async function readFromFileContents(contents: string | Uint8Array): Promise<Uint8Array> {
  validateFromFileContentsInput(contents);
  if (contents instanceof Uint8Array) {
    validateFromFileContentsSize(contents);
    return contents;
  }

  const info = await stat(contents);
  if (info.size > CREATE_FROM_FILE_CONTENTS_MAX_BYTES) {
    throw new CWSandboxValidationError(
      `contents exceeds ${String(CREATE_FROM_FILE_CONTENTS_MAX_BYTES)} bytes (256 KiB).`,
    );
  }
  const bytes = await readFile(contents);
  return Uint8Array.from(bytes);
}
