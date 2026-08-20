// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError } from "../../errors.js";
import {
  posixClean,
  validateFileSystemSnapshotOptions,
  validateMountPath,
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

describe("posixClean", () => {
  it("strips trailing slashes like Go path.Clean", () => {
    expect(posixClean("/workspace/")).toBe("/workspace");
    expect(posixClean("/")).toBe("/");
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
