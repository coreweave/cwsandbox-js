// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError } from "../../errors.js";
import type { Container, VolumeMount } from "../../public/containers.js";
import type { SandboxRunOptions } from "../../public/sandbox.js";
import { validateContainerTarget, validateContainersOption } from "./containers.js";

const cpu = { cpu: "1" };
const main: Container = { image: "python:3.11", name: "main", primary: true, resources: cpu };
const cache: Container = { image: "redis:7", name: "cache", resources: cpu };

function validate(containers: readonly Container[], options: SandboxRunOptions = {}): void {
  validateContainersOption({ ...options, containers }, false);
}

describe("validateContainersOption", () => {
  it("accepts one container without name, primary, or resources", () => {
    expect(() => validate([{ image: "python:3.11" }])).not.toThrow();
    expect(() => validate([{ image: "python:3.11", name: "" }])).not.toThrow();
  });

  it("accepts a primary and a sidecar", () => {
    expect(() =>
      validate([
        { ...main, volumeMounts: [{ mountPath: "/workspace", volume: "workspace" }] },
        cache,
      ]),
    ).not.toThrow();
  });

  it.each<[string, readonly Container[], RegExp]>([
    ["empty list", [], /containers cannot be empty/],
    ["empty image", [{ image: "" }], /containers\[0]\.image cannot be empty/],
    ["uppercase name", [{ image: "busybox", name: "Main" }], /RFC 1123 DNS label/],
    ["dotted name", [{ image: "busybox", name: "helper.one" }], /RFC 1123 DNS label/],
    ["reserved cws-engine", [{ image: "busybox", name: "cws-engine" }], /reserved/],
    ["reserved dns-egress", [{ image: "busybox", name: "dns-egress" }], /reserved/],
    [
      "reserved restore prefix",
      [{ image: "busybox", name: "cw-object-store-agent-restore-1" }],
      /reserved/,
    ],
    [
      "string args",
      [{ args: "--save" as unknown as string[], image: "busybox" }],
      /containers\[0]\.args must be an array/,
    ],
    [
      "non-string arg",
      [{ args: ["--save", 1 as unknown as string], image: "busybox" }],
      /containers\[0]\.args\[1] must be a string/,
    ],
    [
      "relative volume mount",
      [{ image: "busybox", volumeMounts: [{ mountPath: "data", volume: "workspace" }] }],
      /volumeMounts\[0]\.mountPath must be an absolute path/,
    ],
    [
      "empty volume name",
      [{ image: "busybox", volumeMounts: [{ mountPath: "/data", volume: "" }] }],
      /volumeMounts\[0]\.volume cannot be empty/,
    ],
    [
      "null volume mount",
      [{ image: "busybox", volumeMounts: [null as unknown as VolumeMount] }],
      /volumeMounts\[0] must be an object/,
    ],
    [
      "volume mount without mountPath",
      [{ image: "busybox", volumeMounts: [{ volume: "shared" } as unknown as VolumeMount] }],
      /volumeMounts\[0]\.mountPath is required/,
    ],
    [
      "non-string volume mountPath",
      [
        {
          image: "busybox",
          volumeMounts: [{ mountPath: 1, volume: "shared" } as unknown as VolumeMount],
        },
      ],
      /volumeMounts\[0]\.mountPath is required/,
    ],
    [
      "conflicting secrets",
      [
        {
          image: "busybox",
          secrets: [
            { envVar: "TOKEN", name: "a", store: "wandb" },
            { envVar: "TOKEN", name: "b", store: "vault" },
          ],
        },
      ],
      /duplicate envVar: TOKEN/,
    ],
    ["no primary", [{ ...main, primary: false }, cache], /exactly one primary: true/],
    ["two primaries", [main, { ...cache, primary: true }], /exactly one primary: true/],
    [
      "missing name",
      [{ ...main, name: undefined as unknown as string }, cache],
      /every container must have a name/,
    ],
    ["duplicate name", [main, { ...cache, name: "main" }], /duplicate container name: 'main'/],
    [
      "missing resources",
      [main, { image: "redis:7", name: "cache" }],
      /container 'cache' requires resources/,
    ],
  ])("rejects %s", (_name, containers, message) => {
    expect(() => validate(containers)).toThrow(CWSandboxValidationError);
    expect(() => validate(containers)).toThrow(message);
  });

  it("allows the same secret env var on different containers", () => {
    const secrets = [{ envVar: "TOKEN", name: "HF_TOKEN", store: "wandb" }];
    expect(() =>
      validate([
        { ...main, secrets },
        { ...cache, secrets },
      ]),
    ).not.toThrow();
  });

  it.each<[SandboxRunOptions, string]>([
    [{ containerImage: "python:3.12" }, "containerImage"],
    [{ environmentVariables: {} }, "environmentVariables"],
    [{ mountedFiles: [] }, "mountedFiles"],
    [{ resources: cpu }, "resources"],
    [{ secrets: [] }, "secrets"],
  ])("rejects containers with %j", (options, key) => {
    expect(() => validate([{ image: "python:3.11" }], options)).toThrow(
      `containers is mutually exclusive with single-container options (${key})`,
    );
  });

  it("rejects containers with a run() command", () => {
    expect(() => validateContainersOption({ containers: [{ image: "busybox" }] }, true)).toThrow(
      "containers is mutually exclusive with single-container options (command)",
    );
  });

  it("allows sandbox-level volumes with containers", () => {
    expect(() =>
      validate([main, cache], { volumes: [{ mountPath: "/workspace", name: "workspace" }] }),
    ).not.toThrow();
  });
});

describe("validateContainerTarget", () => {
  it("accepts strings and rejects other types", () => {
    expect(() => validateContainerTarget(undefined)).not.toThrow();
    expect(() => validateContainerTarget("")).not.toThrow();
    expect(() => validateContainerTarget(1 as unknown as string)).toThrow(
      "container must be a string.",
    );
  });
});
