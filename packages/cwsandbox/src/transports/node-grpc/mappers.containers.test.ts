// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { validateContainersOption } from "../../internal/validation/containers.js";
import { Sandbox as ProtoSandbox, State } from "./generated/coreweave/sandbox/v1/sandbox.js";
import { toProtoCreateRequest, toSdkGetSandboxResult } from "./mappers.js";

const cpu = (value = "1") => ({ cpu: value });

function spec(request: ReturnType<typeof toProtoCreateRequest>) {
  const result = request.sandbox?.spec;
  if (result === undefined) {
    throw new Error("missing spec");
  }
  return result;
}

describe("multi-container create requests", () => {
  it("leaves name and primary unset for one container", () => {
    const [row, ...rest] = spec(
      toProtoCreateRequest({ containers: [{ args: ["-m", "http.server"], image: "python:3.11" }] }),
    ).containers;

    expect(rest).toEqual([]);
    expect(row).toMatchObject({ args: ["-m", "http.server"], command: "", image: "python:3.11" });
    expect(row?.name).toBe("");
    expect(row?.primary).toBeUndefined();
  });

  it("maps per-container fields and flags only the primary", () => {
    const { containers, volumes } = spec(
      toProtoCreateRequest({
        containers: [
          {
            environmentVariables: { ROLE: "primary" },
            image: "python:3.11",
            name: "main",
            primary: true,
            resources: { limits: cpu("2"), requests: cpu("1") },
            volumeMounts: [{ mountPath: "/shared", readOnly: true, volume: "shared" }],
          },
          {
            args: ["--save", ""],
            command: "redis-server",
            image: "redis:7",
            name: "cache",
            resources: cpu(),
            secrets: [{ name: "TOKEN", store: "wandb" }],
            volumeMounts: [{ mountPath: "/data", subPath: "cache", volume: "shared" }],
          },
        ],
        volumes: [{ mountPath: "/shared", name: "shared" }],
      }),
    );

    expect(containers.map((row) => row.name)).toEqual(["main", "cache"]);
    expect(containers.map((row) => row.primary)).toEqual([true, undefined]);
    expect(containers[0]).toMatchObject({
      environmentVariables: { ROLE: "primary" },
      resourceRequirements: { limits: { cpu: "2" }, requests: { cpu: "1" } },
    });
    expect(containers[1]).toMatchObject({
      args: ["--save", ""],
      command: "redis-server",
      resourceRequirements: { limits: { cpu: "1" }, requests: { cpu: "1" } },
      secretStores: [
        { secrets: [{ envVar: "TOKEN", field: "", path: "TOKEN" }], storeName: "wandb" },
      ],
    });
    expect(volumes.map((volume) => volume.name)).toEqual(["shared"]);
    // The sandbox-level mount matches the primary's own mount, so it is not repeated.
    expect(containers[0]?.volumeMounts).toEqual([
      { mountPath: "/shared", readOnly: true, subPath: "", volume: "shared" },
    ]);
    expect(containers[1]?.volumeMounts).toEqual([
      { mountPath: "/data", readOnly: false, subPath: "cache", volume: "shared" },
    ]);
  });

  it("mounts sandbox volumes on the flagged primary, not the first row", () => {
    const { containers } = spec(
      toProtoCreateRequest({
        containers: [
          { image: "busybox", name: "helper", resources: cpu() },
          { image: "python:3.11", name: "main", primary: true, resources: cpu() },
        ],
        fileSystemSnapshot: { mountPath: "/workspace" },
      }),
    );

    expect(containers[0]?.volumeMounts).toEqual([]);
    expect(containers[1]?.volumeMounts).toMatchObject([
      { mountPath: "/workspace", volume: "workspace" },
    ]);
  });
});

describe("container spec read-back", () => {
  const readBack = (containers: Parameters<typeof ProtoSandbox.create>[0]) =>
    toSdkGetSandboxResult(
      ProtoSandbox.create({ sandboxId: "sbx", status: { state: State.RUNNING }, ...containers }),
    ).containers;

  it("infers the primary on the first row and maps per-container fields", () => {
    const containers = readBack({
      spec: {
        containers: [
          {
            image: "python:3.11",
            name: "main",
            resourceRequirements: { limits: { cpu: "2" }, requests: { cpu: "2" } },
          },
          {
            args: ["--save", ""],
            command: "redis-server",
            environmentVariables: { ROLE: "cache" },
            image: "redis:7",
            name: "cache",
            resourceRequirements: {
              limits: { cpu: "2", memory: "1Gi" },
              requests: { cpu: "1", memory: "1Gi" },
            },
            secretStores: [
              { secrets: [{ envVar: "TOKEN", field: "", path: "HF_TOKEN" }], storeName: "wandb" },
            ],
            volumeMounts: [{ mountPath: "/data", readOnly: true, subPath: "", volume: "shared" }],
          },
        ],
      },
    });

    expect(containers).toEqual([
      { image: "python:3.11", name: "main", primary: true, resources: { cpu: "2" } },
      {
        args: ["--save", ""],
        command: "redis-server",
        environmentVariables: { ROLE: "cache" },
        image: "redis:7",
        name: "cache",
        resources: { limits: { cpu: "2", memory: "1Gi" }, requests: { cpu: "1", memory: "1Gi" } },
        secrets: [{ envVar: "TOKEN", name: "HF_TOKEN", store: "wandb" }],
        volumeMounts: [{ mountPath: "/data", readOnly: true, volume: "shared" }],
      },
    ]);
    expect(() => validateContainersOption({ containers: containers ?? [] }, false)).not.toThrow();
  });

  it("keeps an explicit primary on a later row", () => {
    const containers = readBack({
      spec: {
        containers: [
          { image: "busybox", name: "sidecars" },
          { image: "python:3.11", name: "main", primary: true },
        ],
      },
    });

    expect(containers?.map((row) => row.primary)).toEqual([undefined, true]);
  });

  it("keeps platform rows without create-time checks", () => {
    const containers = readBack({
      spec: { containers: [{ image: "", name: "cws-engine" }] },
    });

    expect(containers).toEqual([{ image: "", name: "cws-engine", primary: true }]);
  });

  it("omits containers when the spec has none", () => {
    expect(readBack({ spec: { containers: [] } })).toBeUndefined();
    expect(readBack({})).toBeUndefined();
  });
});
