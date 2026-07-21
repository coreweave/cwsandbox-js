// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export type Milliseconds = number;
export type Seconds = number;

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: Milliseconds;
}
