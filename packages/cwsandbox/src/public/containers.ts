// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { MountedFiles } from "./files.js";
import type { ResourceOptions } from "./resources.js";
import type { Secrets } from "./secrets.js";

/** Mount of a sandbox-level volume (`volumes` / `fileSystemSnapshot`) into one container. */
export interface VolumeMount {
  /** Name of a volume declared on the sandbox. */
  readonly volume: string;
  /** Absolute directory inside the container (not `/`). */
  readonly mountPath: string;
  readonly readOnly?: boolean;
  /** Path within the volume to mount instead of its root. */
  readonly subPath?: string;
}

/**
 * One user container in a sandbox, for `create({ containers })`.
 *
 * One container: `name` and `primary` may be omitted. More than one: every
 * container needs a `name` and `resources`, and exactly one sets
 * `primary: true`. The primary owns the sandbox lifecycle and is the default
 * target for exec, shell, logs, and files.
 */
export interface Container {
  /** OCI image to run. */
  readonly image: string;
  /**
   * RFC 1123 DNS label, unique in the sandbox. Required when more than one
   * container is specified. Platform names such as `cws-engine` are reserved.
   */
  readonly name?: string;
  /** Entrypoint. Omit to use the image entrypoint; `args` may be set without it. */
  readonly command?: string;
  readonly args?: readonly string[];
  /** Environment variables for this container only. */
  readonly environmentVariables?: Readonly<Record<string, string>>;
  /** CPU and memory for this container. Required when more than one container is specified. */
  readonly resources?: ResourceOptions;
  /** Files written into this container at startup. */
  readonly mountedFiles?: MountedFiles;
  /**
   * Sandbox-level volumes to mount into this container. Every `volumes` /
   * `fileSystemSnapshot` entry is also mounted on the primary at its `mountPath`.
   */
  readonly volumeMounts?: readonly VolumeMount[];
  /** Secret-store references injected into this container only. */
  readonly secrets?: Secrets;
  readonly primary?: boolean;
}
