// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  EndpointAuth,
  EndpointKind,
  Sandbox as ProtoSandbox,
  SandboxMode,
  ServiceProtocol,
  State,
  Visibility,
  type ExecResponse,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import {
  DEFAULT_CONTAINER_IMAGE,
  timeoutMsToSeconds,
  toProtoCreateRequest,
  toProtoExecRequest,
  toProtoListSandboxesRequest,
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

function primaryContainer(request: ReturnType<typeof toProtoCreateRequest>) {
  return request.sandbox?.spec?.containers[0];
}

describe("node transport mappers", () => {
  describe("create requests", () => {
    it("maps start commands to the primary container", () => {
      const request = toProtoCreateRequest({
        command: ["python", "-c", "print('hello')"],
        environmentVariables: {
          EXAMPLE: "1",
        },
        timeoutMs: 1,
      });

      expect(request.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(primaryContainer(request)).toMatchObject({
        args: ["-c", "print('hello')"],
        command: "python",
        environmentVariables: { EXAMPLE: "1" },
        image: DEFAULT_CONTAINER_IMAGE,
        name: "main",
      });
      expect(request.sandbox?.spec?.primaryContainer).toBe("main");
    });

    it("maps supported create options onto spec and the primary container", () => {
      const request = toProtoCreateRequest({
        annotations: { team: "platform" },
        command: ["python", "-m", "http.server", "8000"],
        environmentVariables: { EXAMPLE: "1" },
        maxLifetimeSeconds: 60,
        mountedFiles: { "/workspace/main.py": "print('hello')" },
        network: { denyEgress: true },
        resources: { cpu: "100m", memory: "128Mi" },
        runnerIds: ["runner-id"],
        services: [{ name: "http", port: 8000, protocol: "tcp" }],
        tags: ["project-demo"],
      });

      expect(request.sandbox?.spec).toMatchObject({
        annotations: { team: "platform" },
        maxLifetimeSeconds: 60,
        mode: SandboxMode.CKS,
        network: { denyEgress: true },
        primaryContainer: "main",
        runnerIds: ["runner-id"],
        tags: ["project-demo"],
      });
      expect(request.sandbox?.spec?.services).toMatchObject([
        {
          name: "http",
          port: 8000,
          protocol: ServiceProtocol.TCP,
        },
      ]);
      expect(primaryContainer(request)).toMatchObject({
        args: ["-m", "http.server", "8000"],
        command: "python",
        environmentVariables: { EXAMPLE: "1" },
        resourceRequirements: {
          limits: { cpu: "100m", memory: "128Mi" },
          requests: { cpu: "100m", memory: "128Mi" },
        },
      });
      expect(primaryContainer(request)?.files).toHaveLength(1);
    });

    it("maps annotations onto spec annotations", () => {
      const request = toProtoCreateRequest({
        annotations: {
          purpose: "smoke-test",
          team: "platform",
        },
        command: ["python"],
      });

      expect(request.sandbox?.spec?.annotations).toEqual({
        purpose: "smoke-test",
        team: "platform",
      });
    });

    it("maps mounted file array entries onto container files", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        mountedFiles: [
          {
            content: "print('hello')",
            path: "/workspace/main.py",
          },
        ],
      });

      expect(primaryContainer(request)?.files).toEqual([
        {
          content: textEncoder.encode("print('hello')"),
          path: "/workspace/main.py",
        },
      ]);
    });

    it("maps mounted file record entries onto container files", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        mountedFiles: {
          "/workspace/main.py": "print('hello')",
        },
      });

      expect(primaryContainer(request)?.files).toEqual([
        {
          content: textEncoder.encode("print('hello')"),
          path: "/workspace/main.py",
        },
      ]);
    });

    it("maps byte mounted file content without encoding", () => {
      const content = new Uint8Array([1, 2, 3]);
      const request = toProtoCreateRequest({
        command: ["python"],
        mountedFiles: [
          {
            content,
            path: "/workspace/data.bin",
          },
        ],
      });

      expect(primaryContainer(request)?.files).toEqual([
        {
          content,
          path: "/workspace/data.bin",
        },
      ]);
    });

    it("maps flat resources onto matching requests and limits", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        resources: {
          cpu: "2",
          memory: "4Gi",
        },
      });

      expect(primaryContainer(request)?.resourceRequirements).toEqual({
        limits: { cpu: "2", memory: "4Gi" },
        requests: { cpu: "2", memory: "4Gi" },
      });
    });

    it("maps advanced resources onto requests and limits", () => {
      const request = toProtoCreateRequest({
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

      expect(primaryContainer(request)?.resourceRequirements).toEqual({
        limits: { cpu: "4", memory: "8Gi" },
        requests: { cpu: "1", memory: "1Gi" },
      });
    });

    it("maps listen-only services", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        services: [{ port: 8000 }],
      });

      expect(request.sandbox?.spec?.services).toMatchObject([
        {
          port: 8000,
          protocol: ServiceProtocol.UNSPECIFIED,
          visibility: Visibility.UNSPECIFIED,
        },
      ]);
    });

    it("maps HTTPS public services onto proto services", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        services: [
          {
            endpoint: { auth: "open", kind: "https" },
            name: "http",
            port: 8000,
            protocol: "tcp",
            visibility: "public",
          },
        ],
      });

      expect(request.sandbox?.spec?.services).toMatchObject([
        {
          endpoint: {
            auth: EndpointAuth.OPEN,
            kind: EndpointKind.HTTPS,
          },
          name: "http",
          port: 8000,
          protocol: ServiceProtocol.TCP,
          visibility: Visibility.PUBLIC,
        },
      ]);
    });

    it("omits network when deny flags are unset", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        network: {},
      });

      expect(request.sandbox?.spec?.network).toBeUndefined();
    });

    it("maps deny flags onto proto network options", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        network: {
          denyEgress: true,
          denyIngress: true,
        },
      });

      expect(request.sandbox?.spec?.network).toMatchObject({
        denyEgress: true,
        denyIngress: true,
      });
    });

    it("preserves explicit false deny flags on proto network options", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        network: {
          denyEgress: false,
          denyIngress: false,
        },
      });

      expect(request.sandbox?.spec?.network).toMatchObject({
        denyEgress: false,
        denyIngress: false,
      });
    });

    it("maps runner IDs onto CKS mode", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        runnerIds: ["runner-id"],
      });

      expect(request.sandbox?.spec?.mode).toBe(SandboxMode.CKS);
      expect(request.sandbox?.spec?.runnerIds).toEqual(["runner-id"]);
    });

    it("maps start tags onto spec tags", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        tags: ["project-demo", "purpose-smoke"],
      });

      expect(request.sandbox?.spec?.tags).toEqual(["project-demo", "purpose-smoke"]);
    });

    it("maps secrets with default envVar to a single secret store", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        secrets: [{ store: "wandb-team-secrets", name: "HF_TOKEN" }],
      });

      expect(primaryContainer(request)?.secretStores).toEqual([
        {
          secrets: [{ envVar: "HF_TOKEN", field: "", path: "HF_TOKEN" }],
          storeName: "wandb-team-secrets",
        },
      ]);
    });

    it("maps optional field and envVar on secrets", () => {
      const request = toProtoCreateRequest({
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

      expect(primaryContainer(request)?.secretStores).toEqual([
        {
          secrets: [{ envVar: "DB_PASS", field: "password", path: "db-credentials" }],
          storeName: "wandb-team-secrets",
        },
      ]);
    });

    it("groups secrets by store name", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        secrets: [
          { store: "wandb-team-secrets", name: "HF_TOKEN" },
          { store: "other-store", name: "API_KEY" },
          { envVar: "OPENAI_KEY", name: "OPENAI_API_KEY", store: "wandb-team-secrets" },
        ],
      });

      expect(primaryContainer(request)?.secretStores).toEqual([
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
      const request = toProtoCreateRequest({
        command: ["python"],
      });

      expect(primaryContainer(request)?.secretStores).toEqual([]);
    });
  });

  describe("create and get responses", () => {
    it("maps create responses to SDK sandbox metadata", () => {
      const result = toSdkStartSandboxResult(
        ProtoSandbox.create({
          sandboxId: "sandbox-123",
          status: {
            effectiveResourceRequirements: {
              limits: { cpu: "4", memory: "8Gi" },
              requests: { cpu: "1", memory: "1Gi" },
            },
            runnerId: "runner-id",
            services: [
              {
                name: "http",
                port: 8000,
                protocol: ServiceProtocol.TCP,
                url: "https://sandbox.example.com",
                visibility: Visibility.PUBLIC,
              },
            ],
            startTime: { nanos: 123_000_000, seconds: "1710000000" },
            state: State.RUNNING,
          },
        }),
      );

      expect(result).toEqual({
        exposedPorts: [{ name: "http", port: 8000, protocol: "TCP" }],
        resourceLimits: { cpu: "4", memory: "8Gi" },
        resourceRequests: { cpu: "1", memory: "1Gi" },
        runnerId: "runner-id",
        sandboxId: "sandbox-123",
        serviceUrls: [{ name: "http", port: 8000, url: "https://sandbox.example.com" }],
        startedAt: new Date(1_710_000_000_123),
        status: "running",
      });
    });

    it("maps get responses to SDK sandbox metadata", () => {
      const result = toSdkGetSandboxResult(
        ProtoSandbox.create({
          sandboxId: "sandbox-123",
          status: {
            runnerGroupId: "runner-group-id",
            runnerId: "runner-id",
            startTime: { nanos: 0, seconds: "1710000000" },
            state: State.FAILED,
            stateReason: "Container failed to start.",
          },
        }),
      );

      expect(result).toEqual({
        runnerGroupId: "runner-group-id",
        runnerId: "runner-id",
        sandboxId: "sandbox-123",
        startedAt: new Date(1_710_000_000_000),
        status: "failed",
        statusReason: "Container failed to start.",
      });
      expect(result).not.toHaveProperty("exitCode");
    });

    it("maps get responses with observed exitCode zero", () => {
      const result = toSdkGetSandboxResult(
        ProtoSandbox.create({
          sandboxId: "sandbox-123",
          status: {
            exitCode: 0,
            state: State.COMPLETED,
          },
        }),
      );

      expect(result).toEqual({
        exitCode: 0,
        sandboxId: "sandbox-123",
        status: "completed",
      });
    });

    it("maps get responses with observed nonzero exitCode", () => {
      const result = toSdkGetSandboxResult(
        ProtoSandbox.create({
          sandboxId: "sandbox-123",
          status: {
            exitCode: 67,
            state: State.COMPLETED,
          },
        }),
      );

      expect(result).toEqual({
        exitCode: 67,
        sandboxId: "sandbox-123",
        status: "completed",
      });
    });

    it("maps get responses with observed FAILED exitCode", () => {
      const result = toSdkGetSandboxResult(
        ProtoSandbox.create({
          sandboxId: "sandbox-123",
          status: {
            exitCode: 67,
            state: State.FAILED,
          },
        }),
      );

      expect(result).toEqual({
        exitCode: 67,
        sandboxId: "sandbox-123",
        status: "failed",
      });
    });

    it("prefers endpoint.url when service.url is empty", () => {
      const result = toSdkStartSandboxResult(
        ProtoSandbox.create({
          sandboxId: "sandbox-123",
          status: {
            services: [
              {
                endpoint: {
                  auth: EndpointAuth.OPEN,
                  kind: EndpointKind.HTTPS,
                  url: "https://assigned.example.com",
                },
                name: "http",
                port: 8000,
                visibility: Visibility.PUBLIC,
              },
            ],
            state: State.RUNNING,
          },
        }),
      );

      expect(result.serviceUrls).toEqual([
        { name: "http", port: 8000, url: "https://assigned.example.com" },
      ]);
    });

    it("omits unspecified-visibility services from exposedPorts", () => {
      const result = toSdkStartSandboxResult(
        ProtoSandbox.create({
          sandboxId: "sandbox-123",
          status: {
            services: [
              {
                name: "listen",
                port: 8000,
                visibility: Visibility.UNSPECIFIED,
              },
            ],
            state: State.RUNNING,
          },
        }),
      );

      expect(result.exposedPorts).toBeUndefined();
      expect(result.serviceUrls).toBeUndefined();
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
        command: ["node", "--version"],
        maxOutputBytes: 0,
        sandboxId: "sandbox-123",
      });
    });
  });

  describe("list requests and responses", () => {
    it("maps list filters to the list sandboxes request", () => {
      const request = toProtoListSandboxesRequest({
        pageSize: 10,
        pageToken: "page-1",
        runnerIds: ["runner-id"],
        showTerminated: true,
        status: "running",
        tags: ["tag-a"],
        timeoutMs: 1500,
      });

      expect(request).toMatchObject({
        pageSize: 10,
        pageToken: "page-1",
        runnerIds: ["runner-id"],
        showTerminated: true,
        state: State.RUNNING,
        tags: ["tag-a"],
      });
    });

    it("maps list responses to SDK sandbox info", () => {
      const result = toSdkListSandboxesResult({
        nextPageToken: "next-page",
        sandboxes: [
          ProtoSandbox.create({
            sandboxId: "sandbox-123",
            status: {
              runnerGroupId: "runner-group-id",
              runnerId: "runner-id",
              services: [
                {
                  name: "http",
                  port: 8000,
                  protocol: ServiceProtocol.TCP,
                  url: "https://sandbox.example.com",
                  visibility: Visibility.PUBLIC,
                },
              ],
              startTime: { nanos: 0, seconds: "1710000000" },
              state: State.RUNNING,
            },
          }),
        ],
      });

      expect(result).toEqual({
        nextPageToken: "next-page",
        sandboxes: [
          {
            exposedPorts: [{ name: "http", port: 8000, protocol: "TCP" }],
            runnerGroupId: "runner-group-id",
            runnerId: "runner-id",
            sandboxId: "sandbox-123",
            serviceUrls: [{ name: "http", port: 8000, url: "https://sandbox.example.com" }],
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
      expect(toSdkSandboxStatus(State.RUNNING)).toBe("running");
      expect(toSdkSandboxStatus(State.TERMINATING)).toBe("terminating");
      expect(toSdkSandboxStatus(State.UNSPECIFIED)).toBe("unspecified");
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
