// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import type { ExecResponse } from "./generated/coreweave/sandbox/v1beta2/gateway.js";
import {
  OutputPolicy as ProtoOutputPolicy,
  SandboxStatus as ProtoSandboxStatus,
} from "./generated/coreweave/sandbox/v1beta2/gateway.js";
import {
  DEFAULT_CONTAINER_IMAGE,
  timeoutMsToSeconds,
  toProtoExecRequest,
  toProtoListSandboxesRequest,
  toProtoStartRequest,
  toSdkGetSandboxResult,
  toSdkListSandboxesResult,
  toSdkProcessResult,
  toSdkSandboxStatus,
  toSdkStartSandboxResult,
} from "./mappers.js";

const textEncoder = new TextEncoder();

function execResponse(stdout: string, stderr = "", exitCode = 0): ExecResponse {
  return {
    exitCode,
    stderr: textEncoder.encode(stderr),
    stderrBytesProduced: String(stderr.length),
    stderrTruncated: false,
    stdout: textEncoder.encode(stdout),
    stdoutBytesProduced: String(stdout.length),
    stdoutTruncated: false,
  };
}

describe("node transport mappers", () => {
  describe("start requests", () => {
    it("maps start commands to command and args", () => {
      const request = toProtoStartRequest({
        command: ["python", "-c", "print('hello')"],
        environmentVariables: {
          EXAMPLE: "1",
        },
        timeoutMs: 1,
      });

      expect(request.command).toBe("python");
      expect(request.args).toEqual(["-c", "print('hello')"]);
      expect(request.containerImage).toBe(DEFAULT_CONTAINER_IMAGE);
      expect(request.environmentVariables).toEqual({ EXAMPLE: "1" });
      expect(request.maxTimeoutSeconds).toBe(1);
    });

    it("maps supported start options to the start request", () => {
      const request = toProtoStartRequest({
        annotations: { team: "platform" },
        command: ["python", "-m", "http.server", "8000"],
        environmentVariables: { EXAMPLE: "1" },
        maxLifetimeSeconds: 60,
        mountedFiles: { "/workspace/main.py": "print('hello')" },
        network: { egressMode: "internet", exposedPorts: [8000], ingressMode: "public" },
        ports: [{ name: "http", port: 8000, protocol: "TCP" }],
        profileNames: ["default"],
        resources: { cpu: "100m", memory: "128Mi" },
        runnerIds: ["runner-id"],
        tags: ["project-demo"],
        timeoutMs: 1500,
      });

      expect(request).toMatchObject({
        args: ["-m", "http.server", "8000"],
        command: "python",
        environmentVariables: { EXAMPLE: "1" },
        maxLifetimeSeconds: 60,
        maxTimeoutSeconds: 2,
        network: { egressMode: "internet", exposedPorts: [8000], ingressMode: "public" },
        podAnnotations: { team: "platform" },
        ports: [{ containerPort: 8000, name: "http", protocol: "TCP" }],
        profileNames: ["default"],
        resources: { cpu: "100m", memory: "128Mi" },
        runnerIds: ["runner-id"],
        tags: ["project-demo"],
      });
      expect(request.mountedFiles).toHaveLength(1);
    });

    it("maps annotations to pod annotations", () => {
      const request = toProtoStartRequest({
        annotations: {
          purpose: "smoke-test",
          team: "platform",
        },
        command: ["python"],
      });

      expect(request.podAnnotations).toEqual({
        purpose: "smoke-test",
        team: "platform",
      });
    });

    it("maps mounted file array entries to mounted files", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        mountedFiles: [
          {
            content: "print('hello')",
            path: "/workspace/main.py",
          },
        ],
      });

      expect(request.mountedFiles).toEqual([
        {
          fileContent: textEncoder.encode("print('hello')"),
          mountPath: "/workspace/main.py",
        },
      ]);
    });

    it("maps mounted file record entries to mounted files", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        mountedFiles: {
          "/workspace/main.py": "print('hello')",
        },
      });

      expect(request.mountedFiles).toEqual([
        {
          fileContent: textEncoder.encode("print('hello')"),
          mountPath: "/workspace/main.py",
        },
      ]);
    });

    it("maps byte mounted file content without encoding", () => {
      const content = new Uint8Array([1, 2, 3]);
      const request = toProtoStartRequest({
        command: ["python"],
        mountedFiles: [
          {
            content,
            path: "/workspace/data.bin",
          },
        ],
      });

      expect(request.mountedFiles).toEqual([
        {
          fileContent: content,
          mountPath: "/workspace/data.bin",
        },
      ]);
    });

    it("maps flat resources to guaranteed resource requests", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        resources: {
          cpu: "2",
          memory: "4Gi",
        },
      });

      expect(request.resources).toEqual({
        cpu: "2",
        memory: "4Gi",
      });
      expect(request.resourceRequests).toBeUndefined();
      expect(request.resourceLimits).toBeUndefined();
    });

    it("maps advanced resources to requests and limits", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        resources: {
          limits: {
            cpu: "4",
            memory: "8Gi",
          },
          requests: {
            cpu: "1",
            memory: "1Gi",
          },
        },
      });

      expect(request.resources).toBeUndefined();
      expect(request.resourceRequests).toEqual({
        cpu: "1",
        memory: "1Gi",
      });
      expect(request.resourceLimits).toEqual({
        cpu: "4",
        memory: "8Gi",
      });
    });

    it("maps numeric ports to container ports", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        ports: [8000],
      });

      expect(request.ports).toEqual([
        {
          containerPort: 8000,
          name: "",
          protocol: "",
        },
      ]);
    });

    it("maps object ports to container ports", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        ports: [{ name: "http", port: 8000, protocol: "TCP" }],
      });

      expect(request.ports).toEqual([
        {
          containerPort: 8000,
          name: "http",
          protocol: "TCP",
        },
      ]);
    });

    it("maps network options to the start request", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        network: {
          egressMode: "internet",
          exposedPorts: [8000],
          ingressMode: "public",
        },
        ports: [8000],
      });

      expect(request.network).toEqual({
        egressMode: "internet",
        exposedPorts: [8000],
        ingressMode: "public",
      });
    });

    it("maps egress-only network options to the start request", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        network: {
          egressMode: "internet",
        },
      });

      expect(request.network).toEqual({
        egressMode: "internet",
        exposedPorts: [],
        ingressMode: "",
      });
    });

    it("maps start selectors to profile and runner fields", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        profileIds: ["profile-id"],
        profileNames: ["profile-name"],
        runnerIds: ["runner-id"],
      });

      expect(request.profileIds).toEqual(["profile-id"]);
      expect(request.profileNames).toEqual(["profile-name"]);
      expect(request.runnerIds).toEqual(["runner-id"]);
    });

    it("maps start tags to tags", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        tags: ["project-demo", "purpose-smoke"],
      });

      expect(request.tags).toEqual(["project-demo", "purpose-smoke"]);
    });

    it("maps secrets with default envVar to a single secret store", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        secrets: [{ store: "wandb-team-secrets", name: "HF_TOKEN" }],
      });

      expect(request.secretStores).toEqual([
        {
          secrets: [{ envVar: "HF_TOKEN", field: "", path: "HF_TOKEN" }],
          storeName: "wandb-team-secrets",
        },
      ]);
    });

    it("maps optional field and envVar on secrets", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        secrets: [
          {
            envVar: "DB_PASS",
            field: "password",
            name: "db-credentials",
            store: "wandb-team-secrets",
          },
        ],
      });

      expect(request.secretStores).toEqual([
        {
          secrets: [{ envVar: "DB_PASS", field: "password", path: "db-credentials" }],
          storeName: "wandb-team-secrets",
        },
      ]);
    });

    it("groups secrets by store name", () => {
      const request = toProtoStartRequest({
        command: ["python"],
        secrets: [
          { store: "wandb-team-secrets", name: "HF_TOKEN" },
          { store: "other-store", name: "API_KEY" },
          { envVar: "OPENAI_KEY", name: "OPENAI_API_KEY", store: "wandb-team-secrets" },
        ],
      });

      expect(request.secretStores).toEqual([
        {
          secrets: [
            { envVar: "HF_TOKEN", field: "", path: "HF_TOKEN" },
            { envVar: "OPENAI_KEY", field: "", path: "OPENAI_API_KEY" },
          ],
          storeName: "wandb-team-secrets",
        },
        {
          secrets: [{ envVar: "API_KEY", field: "", path: "API_KEY" }],
          storeName: "other-store",
        },
      ]);
    });

    it("maps omitted secrets to an empty secretStores list", () => {
      const request = toProtoStartRequest({
        command: ["python"],
      });

      expect(request.secretStores).toEqual([]);
    });
  });

  describe("start and get responses", () => {
    it("maps start responses to SDK sandbox metadata", () => {
      const result = toSdkStartSandboxResult({
        appliedEgressMode: "internet",
        appliedIngressMode: "public",
        exposedPorts: [{ containerPort: 8000, name: "http", protocol: "TCP" }],
        profileId: "profile-id",
        requestedResourceLimits: { cpu: "4", memory: "8Gi" },
        requestedResourceRequests: { cpu: "1", memory: "1Gi" },
        runnerId: "runner-id",
        sandboxId: "sandbox-123",
        sandboxStatus: ProtoSandboxStatus.RUNNING,
        serviceAddress: "sandbox.example.com",
        startedAtTime: { nanos: 123_000_000, seconds: "1710000000" },
      });

      expect(result).toEqual({
        appliedEgressMode: "internet",
        appliedIngressMode: "public",
        exposedPorts: [{ name: "http", port: 8000, protocol: "TCP" }],
        profileId: "profile-id",
        resourceLimits: { cpu: "4", memory: "8Gi" },
        resourceRequests: { cpu: "1", memory: "1Gi" },
        runnerId: "runner-id",
        sandboxId: "sandbox-123",
        serviceAddress: "sandbox.example.com",
        startedAt: new Date(1_710_000_000_123),
        status: "running",
      });
    });

    it("maps get responses to SDK sandbox metadata", () => {
      const result = toSdkGetSandboxResult({
        appliedEgressMode: "none",
        appliedIngressMode: "",
        exposedPorts: [],
        profileId: "profile-id",
        runnerGroupId: "runner-group-id",
        runnerId: "runner-id",
        sandboxId: "sandbox-123",
        sandboxStatus: ProtoSandboxStatus.FAILED,
        serviceAddress: "",
        startedAtTime: { nanos: 0, seconds: "1710000000" },
        statusReason: "Container failed to start.",
      });

      expect(result).toEqual({
        appliedEgressMode: "none",
        profileId: "profile-id",
        runnerGroupId: "runner-group-id",
        runnerId: "runner-id",
        sandboxId: "sandbox-123",
        startedAt: new Date(1_710_000_000_000),
        status: "failed",
        statusReason: "Container failed to start.",
      });
    });
  });

  describe("exec requests", () => {
    it("maps exec commands to the repeated command field", () => {
      const request = toProtoExecRequest({
        command: ["node", "--version"],
        sandboxId: "sandbox-123",
        timeoutMs: 1500,
      });

      expect(request).toMatchObject({
        args: [],
        command: ["node", "--version"],
        maxTimeoutSeconds: 2,
        sandboxId: "sandbox-123",
      });
    });

    it("maps exec buffer caps to buffered output policy", () => {
      const request = toProtoExecRequest({
        bufferedMaxKiB: 64,
        command: ["node", "--version"],
        sandboxId: "sandbox-123",
      });

      expect(request).toMatchObject({
        bufferedMaxKib: 64,
        outputHandling: ProtoOutputPolicy.BUFFERED,
      });
    });
  });

  describe("list requests and responses", () => {
    it("maps list filters to the list sandboxes request", () => {
      const request = toProtoListSandboxesRequest({
        includeStopped: true,
        pageSize: 10,
        pageToken: "page-1",
        profileIds: ["profile-id"],
        profileNames: ["profile-name"],
        runnerIds: ["runner-id"],
        status: "running",
        tags: ["tag-a"],
        timeoutMs: 1500,
      });

      expect(request).toEqual({
        includeStopped: true,
        maxTimeoutSeconds: 2,
        pageSize: 10,
        pageToken: "page-1",
        profileIds: ["profile-id"],
        profileNames: ["profile-name"],
        runnerIds: ["runner-id"],
        status: ProtoSandboxStatus.RUNNING,
        tags: ["tag-a"],
        volumeIds: [],
      });
    });

    it("maps list responses to SDK sandbox info", () => {
      const result = toSdkListSandboxesResult({
        nextPageToken: "next-page",
        sandboxes: [
          {
            appliedEgressMode: "internet",
            appliedIngressMode: "public",
            exposedPorts: [{ containerPort: 8000, name: "http", protocol: "TCP" }],
            profileId: "profile-id",
            runnerGroupId: "runner-group-id",
            runnerId: "runner-id",
            sandboxId: "sandbox-123",
            sandboxStatus: ProtoSandboxStatus.RUNNING,
            serviceAddress: "sandbox.example.com",
            startedAtTime: { nanos: 0, seconds: "1710000000" },
          },
        ],
      });

      expect(result).toEqual({
        nextPageToken: "next-page",
        sandboxes: [
          {
            appliedEgressMode: "internet",
            appliedIngressMode: "public",
            exposedPorts: [{ name: "http", port: 8000, protocol: "TCP" }],
            profileId: "profile-id",
            runnerGroupId: "runner-group-id",
            runnerId: "runner-id",
            sandboxId: "sandbox-123",
            serviceAddress: "sandbox.example.com",
            startedAt: new Date(1_710_000_000_000),
            status: "running",
          },
        ],
      });
    });
  });

  describe("exec cwd wrapping", () => {
    it("wraps exec commands with a working directory in a shell command", () => {
      const request = toProtoExecRequest({
        command: ["printf", "hello world"],
        cwd: "/workspace/it's here",
        sandboxId: "sandbox-123",
      });

      expect(request.command).toEqual([
        "/bin/sh",
        "-lc",
        "cd '/workspace/it'\\''s here' && exec 'printf' 'hello world'",
      ]);
    });

    it("quotes exec command args when wrapping with a working directory", () => {
      const request = toProtoExecRequest({
        command: ["printf", "it's ok"],
        cwd: "/workspace",
        sandboxId: "sandbox-123",
      });

      expect(request.command).toEqual([
        "/bin/sh",
        "-lc",
        "cd '/workspace' && exec 'printf' 'it'\\''s ok'",
      ]);
    });
  });

  describe("status, result, and timeout helpers", () => {
    it("maps protobuf status enums to SDK status strings", () => {
      expect(toSdkSandboxStatus(ProtoSandboxStatus.RUNNING)).toBe("running");
      expect(toSdkSandboxStatus(ProtoSandboxStatus.TERMINATING)).toBe("terminating");
      expect(toSdkSandboxStatus(ProtoSandboxStatus.UNSPECIFIED)).toBe("unspecified");
    });

    it("maps exec output bytes to strings", () => {
      const result = toSdkProcessResult(["echo", "hello"], execResponse("hello\n", "", 0));

      expect(result).toEqual({
        command: ["echo", "hello"],
        exitCode: 0,
        failed: false,
        ok: true,
        stderr: "",
        stderrBytes: new Uint8Array(),
        stderrBytesProduced: 0,
        stderrTruncated: false,
        stdout: "hello\n",
        stdoutBytes: textEncoder.encode("hello\n"),
        stdoutBytesProduced: 6,
        stdoutTruncated: false,
      });
    });

    it("converts millisecond timeouts to rounded-up seconds", () => {
      expect(timeoutMsToSeconds(undefined)).toBe(0);
      expect(timeoutMsToSeconds(1)).toBe(1);
      expect(timeoutMsToSeconds(1000)).toBe(1);
      expect(timeoutMsToSeconds(1001)).toBe(2);
    });
  });
});
