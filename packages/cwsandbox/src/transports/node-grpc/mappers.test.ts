// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  EndpointAuth,
  EndpointKind,
  FileSystemSnapshot,
  Sandbox as ProtoSandbox,
  SandboxMode,
  ServiceProtocol,
  SnapshotState,
  SnapshotTrigger,
  State,
  Visibility,
  type ExecResponse,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import { Timestamp } from "./generated/google/protobuf/timestamp.js";
import {
  DEFAULT_CONTAINER_IMAGE,
  timeoutMsToSeconds,
  toProtoCreateRequest,
  toProtoExecRequest,
  toProtoListSandboxesRequest,
  toSdkFileSystemSnapshot,
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

    it("maps fileSystemSnapshot onto a workspace scratch volume and primary mount", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        fileSystemSnapshot: {
          mountPath: "/workspace",
          size: "10Gi",
          restoreFromSnapshotId: "snap-123",
        },
      });

      expect(request.sandbox?.spec?.volumes).toEqual([
        {
          name: "workspace",
          source: {
            oneofKind: "scratch",
            scratch: {
              medium: 0,
              restoreFromSnapshotId: "snap-123",
              size: "10Gi",
            },
          },
        },
      ]);
      expect(primaryContainer(request)?.volumeMounts).toEqual([
        {
          mountPath: "/workspace",
          readOnly: false,
          subPath: "",
          volume: "workspace",
        },
      ]);
    });

    it("omits empty restoreFromSnapshotId and size on the scratch volume", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        fileSystemSnapshot: {
          mountPath: "/workspace",
          restoreFromSnapshotId: "",
          size: "",
        },
      });

      expect(request.sandbox?.spec?.volumes?.[0]?.source).toEqual({
        oneofKind: "scratch",
        scratch: {
          medium: 0,
          restoreFromSnapshotId: "",
          size: "",
        },
      });
    });

    it("maps volumes onto named scratch volumes and primary mounts", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        volumes: [
          {
            mountPath: "/workspace",
            name: "workspace",
            size: "10Gi",
          },
          {
            mountPath: "/cache",
            name: "cache",
            restoreFromSnapshotId: "snap-cache",
          },
        ],
      });

      expect(request.sandbox?.spec?.volumes).toEqual([
        {
          name: "workspace",
          source: {
            oneofKind: "scratch",
            scratch: {
              medium: 0,
              restoreFromSnapshotId: "",
              size: "10Gi",
            },
          },
        },
        {
          name: "cache",
          source: {
            oneofKind: "scratch",
            scratch: {
              medium: 0,
              restoreFromSnapshotId: "snap-cache",
              size: "",
            },
          },
        },
      ]);
      expect(primaryContainer(request)?.volumeMounts).toEqual([
        {
          mountPath: "/workspace",
          readOnly: false,
          subPath: "",
          volume: "workspace",
        },
        {
          mountPath: "/cache",
          readOnly: false,
          subPath: "",
          volume: "cache",
        },
      ]);
    });

    it("maps objectStorageAccess onto spec", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        objectStorageAccess: {
          buckets: ["bucket-a", "bucket-b"],
          objectPrefix: "tenants/org-abc/cache/",
          permission: "read-write",
        },
      });

      expect(request.sandbox?.spec?.objectStorageAccess).toEqual({
        buckets: ["bucket-a", "bucket-b"],
        objectPrefix: "tenants/org-abc/cache/",
        permission: 2,
      });
    });

    it("maps read objectStorageAccess and omits empty objectPrefix", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
        objectStorageAccess: {
          buckets: ["bucket-a"],
          objectPrefix: "",
          permission: "read",
        },
      });

      expect(request.sandbox?.spec?.objectStorageAccess).toEqual({
        buckets: ["bucket-a"],
        objectPrefix: "",
        permission: 1,
      });
    });

    it("omits volumes, mounts, and objectStorageAccess when unset", () => {
      const request = toProtoCreateRequest({
        command: ["python"],
      });

      expect(request.sandbox?.spec?.volumes).toEqual([]);
      expect(primaryContainer(request)?.volumeMounts).toEqual([]);
      expect(request.sandbox?.spec?.objectStorageAccess).toBeUndefined();
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

  describe("file-system snapshots", () => {
    it("maps READY snapshots and safe sizeBytes", () => {
      expect(
        toSdkFileSystemSnapshot(
          FileSystemSnapshot.create({
            fileSystemSnapshotId: "snap-1",
            sizeBytes: "4096",
            state: SnapshotState.READY,
            stateReason: "",
          }),
        ),
      ).toEqual({
        snapshotId: "snap-1",
        sizeBytes: 4096,
        state: "ready",
        trigger: "unspecified",
      });
    });

    it("omits sizeBytes that are empty or not a safe integer", () => {
      expect(
        toSdkFileSystemSnapshot(
          FileSystemSnapshot.create({
            fileSystemSnapshotId: "snap-2",
            sizeBytes: "",
            state: SnapshotState.CREATING,
          }),
        ),
      ).toEqual({
        snapshotId: "snap-2",
        state: "creating",
        trigger: "unspecified",
      });
      expect(
        toSdkFileSystemSnapshot(
          FileSystemSnapshot.create({
            fileSystemSnapshotId: "snap-3",
            sizeBytes: "9007199254740993",
            state: SnapshotState.READY,
          }),
        ).sizeBytes,
      ).toBeUndefined();
    });

    it("includes sizeBytes of 0 when the READY Get reports it", () => {
      expect(
        toSdkFileSystemSnapshot(
          FileSystemSnapshot.create({
            fileSystemSnapshotId: "snap-4",
            sizeBytes: "0",
            state: SnapshotState.READY,
          }),
        ),
      ).toMatchObject({
        sizeBytes: 0,
        snapshotId: "snap-4",
        state: "ready",
      });
    });

    it("maps remaining Get/List fields and omits empty strings", () => {
      const createdAt = Timestamp.create({ nanos: 0, seconds: "1700000000" });
      expect(
        toSdkFileSystemSnapshot(
          FileSystemSnapshot.create({
            completeTime: Timestamp.create({ nanos: 0, seconds: "1700000060" }),
            createTime: createdAt,
            fileSystemSnapshotId: "snap-full",
            objectBucket: "org-fss",
            requestId: "req-1",
            sizeBytes: "12",
            sourceSandboxId: "sbx-1",
            sourceVolumeName: "workspace",
            state: SnapshotState.READY,
            stateReason: "ok",
            trigger: SnapshotTrigger.MANUAL,
            updatedAt: Timestamp.create({ nanos: 1_000_000, seconds: "1700000030" }),
          }),
        ),
      ).toEqual({
        completedAt: new Date(1_700_000_060_000),
        createdAt: new Date(1_700_000_000_000),
        objectBucket: "org-fss",
        requestId: "req-1",
        sizeBytes: 12,
        snapshotId: "snap-full",
        sourceSandboxId: "sbx-1",
        sourceVolumeName: "workspace",
        state: "ready",
        stateReason: "ok",
        trigger: "manual",
        updatedAt: new Date(1_700_000_030_001),
      });
    });

    it("throws on unknown trigger values", () => {
      expect(() =>
        toSdkFileSystemSnapshot(
          FileSystemSnapshot.create({
            fileSystemSnapshotId: "snap-unknown",
            state: SnapshotState.READY,
            trigger: 99 as SnapshotTrigger,
          }),
        ),
      ).toThrow(/Unhandled snapshot trigger/);
    });

    it("throws on unknown state values", () => {
      expect(() =>
        toSdkFileSystemSnapshot(
          FileSystemSnapshot.create({
            fileSystemSnapshotId: "snap-unknown-state",
            state: 99 as SnapshotState,
          }),
        ),
      ).toThrow(/Unhandled snapshot state/);
    });
  });
});
