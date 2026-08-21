// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError } from "../../errors.js";
import {
  validateFileSystemSnapshotOptions,
  validateMountPath,
  validateSandboxVolumeCreateOptions,
  validateScratchVolumeOptions,
} from "./file-system-snapshot.js";
import { validateObjectPrefix, validateObjectStorageAccess } from "./object-storage.js";

describe("validateMountPath", () => {
  it("accepts a normal workspace path", () => {
    expect(() => validateMountPath("/workspace")).not.toThrow();
  });

  it("rejects empty, relative, root, trailing slash, and reserved prefixes", () => {
    expect(() => validateMountPath("")).toThrow(CWSandboxValidationError);
    expect(() => validateMountPath("workspace")).toThrow(/absolute/);
    expect(() => validateMountPath("/")).toThrow(/must not be '\/'/);
    expect(() => validateMountPath("/workspace/")).toThrow(/canonical/);
    expect(() => validateMountPath("/foo/../bar")).toThrow(/canonical/);
    expect(() => validateMountPath("/proc")).toThrow(/\/proc/);
    expect(() => validateMountPath("/etc/passwd")).toThrow(/\/etc/);
    expect(() => validateMountPath("/var/run/secrets/token")).toThrow(/\/var\/run\/secrets/);
  });

  it("rejects paths longer than 256 characters", () => {
    expect(() => validateMountPath(`/${"a".repeat(256)}`)).toThrow(/256/);
  });
});

describe("validateFileSystemSnapshotOptions", () => {
  it("rejects overlap with mounted files", () => {
    expect(() =>
      validateFileSystemSnapshotOptions(
        { mountPath: "/workspace" },
        { "/workspace/main.py": "print('hi')" },
      ),
    ).toThrow(/conflicts with mounted file/);
  });

  it("allows empty restoreFromSnapshotId and size", () => {
    expect(() =>
      validateFileSystemSnapshotOptions(
        { mountPath: "/workspace", restoreFromSnapshotId: "", size: "" },
        undefined,
      ),
    ).not.toThrow();
  });
});

describe("validateScratchVolumeOptions", () => {
  it("rejects an empty volumes array", () => {
    expect(() => validateScratchVolumeOptions([], undefined)).toThrow(/must not be empty/);
  });

  it("rejects an empty volume name", () => {
    expect(() =>
      validateScratchVolumeOptions([{ mountPath: "/data", name: "" }], undefined),
    ).toThrow(/volumes\[0]\.name is required/);
  });

  it("rejects duplicate names and mount paths", () => {
    expect(() =>
      validateScratchVolumeOptions(
        [
          { mountPath: "/workspace", name: "workspace" },
          { mountPath: "/cache", name: "workspace" },
        ],
        undefined,
      ),
    ).toThrow(/duplicates 'workspace'/);
    expect(() =>
      validateScratchVolumeOptions(
        [
          { mountPath: "/data", name: "one" },
          { mountPath: "/data", name: "two" },
        ],
        undefined,
      ),
    ).toThrow(/duplicates '\/data'/);
  });

  it("rejects overlap with mounted files", () => {
    expect(() =>
      validateScratchVolumeOptions([{ mountPath: "/workspace", name: "workspace" }], {
        "/workspace/main.py": "print('hi')",
      }),
    ).toThrow(/volumes\[0]\.mountPath conflicts with mounted file/);
  });

  it("rejects reserved mount paths with the volumes field name", () => {
    expect(() =>
      validateScratchVolumeOptions([{ mountPath: "/etc/passwd", name: "data" }], undefined),
    ).toThrow(/volumes\[0]\.mountPath must not be equal to or under \/etc/);
  });
});

describe("validateSandboxVolumeCreateOptions", () => {
  it("rejects fileSystemSnapshot and volumes together", () => {
    expect(() =>
      validateSandboxVolumeCreateOptions({
        fileSystemSnapshot: { mountPath: "/workspace" },
        volumes: [{ mountPath: "/data", name: "data" }],
      }),
    ).toThrow(/fileSystemSnapshot and volumes cannot be used together/);
  });
});

describe("validateObjectPrefix", () => {
  it("allows empty and valid prefixes", () => {
    expect(() => validateObjectPrefix(undefined)).not.toThrow();
    expect(() => validateObjectPrefix("")).not.toThrow();
    expect(() => validateObjectPrefix("tenants/org-abc/cache/")).not.toThrow();
    expect(() => validateObjectPrefix("a/")).not.toThrow();
  });

  it("rejects missing trailing slash, wildcards, traversal, and length", () => {
    expect(() => validateObjectPrefix("tenants/org-abc/cache")).toThrow(CWSandboxValidationError);
    expect(() => validateObjectPrefix("/tenants/x/")).toThrow(CWSandboxValidationError);
    expect(() => validateObjectPrefix("tenants/*/cache/")).toThrow(CWSandboxValidationError);
    expect(() => validateObjectPrefix("tenants/../etc/")).toThrow(CWSandboxValidationError);
    expect(() => validateObjectPrefix("tenants//cache/")).toThrow(CWSandboxValidationError);
    expect(() => validateObjectPrefix(`a${"b".repeat(511)}/`)).toThrow(/512/);
  });
});

describe("validateObjectStorageAccess", () => {
  it("requires unique non-empty buckets and a known permission", () => {
    expect(() => validateObjectStorageAccess({ buckets: [], permission: "read" })).toThrow(
      /must not be empty/,
    );
    expect(() =>
      validateObjectStorageAccess({ buckets: ["dup", "dup"], permission: "read" }),
    ).toThrow(/duplicate/);
    expect(() =>
      validateObjectStorageAccess({
        buckets: ["ok"],
        permission: "write" as "read",
      }),
    ).toThrow(/read-write/);
  });
});
