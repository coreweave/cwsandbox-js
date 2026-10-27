// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it, vi } from "vitest";

import type { DirectDataPlane, DirectDataPlaneLease } from "./direct-data-plane.js";
import { createGrpcFileAdapter } from "./file-adapter.js";
import type { SandboxServiceClient } from "./generated/coreweave/sandbox/v1/sandbox.client.js";
import type {
  ExecStreamRequest,
  ExecStreamResponse,
} from "./generated/coreweave/sandbox/v1/sandbox.js";
import { GrpcSandboxTransport } from "./grpc-transport.js";

type Route = "direct" | "gateway";

interface Recorded {
  readonly container: string;
}

function recordingClient() {
  const unary: Recorded[] = [];
  const streamInits: Recorded[] = [];
  const logs: Recorded[] = [];

  const execStream = () => {
    const frames: ExecStreamResponse[] = [
      { message: { oneofKind: "ready", ready: {} } },
      { message: { oneofKind: "stdout", stdout: { data: new TextEncoder().encode("3") } } },
      { message: { exit: { exitCode: 0 }, oneofKind: "exit" } },
    ] as ExecStreamResponse[];
    return {
      requests: {
        complete: async () => undefined,
        send: async (message: ExecStreamRequest) => {
          if (message.message.oneofKind === "init") {
            streamInits.push(message.message.init);
          }
        },
      },
      responses: (async function* () {
        yield* frames;
      })(),
      status: Promise.resolve({ code: "OK", detail: "" }),
    };
  };

  const client = {
    exec(request: Recorded) {
      unary.push(request);
      return {
        response: Promise.resolve({
          exitCode: 0,
          stderr: new Uint8Array(),
          stdout: new Uint8Array(),
        }),
      };
    },
    readFile(request: Recorded) {
      unary.push(request);
      return { response: Promise.resolve({ content: new Uint8Array([1, 2, 3]) }) };
    },
    streamExec: execStream,
    streamLogs(request: Recorded) {
      logs.push(request);
      return {
        responses: (async function* () {})(),
        status: Promise.resolve({ code: "OK", detail: "" }),
      };
    },
    writeFile(request: Recorded) {
      unary.push(request);
      return { response: Promise.resolve({}) };
    },
  };
  return { client, logs, streamInits, unary };
}

function setup(route: Route) {
  const recorder = recordingClient();
  const lease = {
    client: recorder.client,
    discard: async () => undefined,
    release: async () => undefined,
  } as unknown as DirectDataPlaneLease;
  const gateway = route === "gateway" ? recorder.client : {};
  const acquire = vi.fn<() => Promise<DirectDataPlaneLease | undefined>>(async () =>
    route === "direct" ? lease : undefined,
  );

  const transport = new GrpcSandboxTransport({ apiKey: "test", baseUrl: "http://127.0.0.1:1" });
  Object.defineProperty(transport, "client", { value: gateway });
  vi.spyOn(transport.directDataPlane, "acquire").mockImplementation(acquire);

  const adapter = createGrpcFileAdapter({ client: gateway as SandboxServiceClient }, {
    acquire,
  } as unknown as DirectDataPlane);
  return { adapter, recorder, transport };
}

describe.each<Route>(["gateway", "direct"])("container target over %s", (route) => {
  const base = { dataPlaneMode: route, sandboxId: "sbx" } as const;

  it("sets container on exec, streaming exec, shell, and logs", async () => {
    const { recorder, transport } = setup(route);

    await transport.exec({ ...base, command: ["hostname"], container: "sidecar" });
    const process = await transport.startCommand({
      ...base,
      command: ["cat"],
      container: "sidecar",
    });
    await process.wait();
    const shell = await transport.startShell({
      ...base,
      command: ["/bin/sh"],
      container: " sidecar ",
    });
    await shell.wait();
    const logs = await transport.streamLogs({ ...base, container: "sidecar", mode: "lines" });
    await logs.close();

    expect(recorder.unary.map((request) => request.container)).toEqual(["sidecar"]);
    expect(recorder.streamInits.map((init) => init.container)).toEqual(["sidecar", "sidecar"]);
    expect(recorder.logs.map((request) => request.container)).toEqual(["sidecar"]);
  });

  it("sets container on file read, write, readStream, and writeStream", async () => {
    const { adapter, recorder } = setup(route);

    await adapter.read({ ...base, container: "sidecar", path: "/tmp/a" });
    await adapter.write({
      ...base,
      container: "sidecar",
      content: new Uint8Array([1]),
      path: "/tmp/a",
    });
    for await (const _chunk of adapter.readStream({
      ...base,
      container: "sidecar",
      path: "/tmp/a",
    })) {
      // drain
    }
    await adapter.writeStream({
      ...base,
      container: "sidecar",
      mode: "direct",
      path: "/tmp/a",
      source: new Uint8Array([1]),
    });

    expect(recorder.unary.map((request) => request.container)).toEqual(["sidecar", "sidecar"]);
    // readStream runs stat then cat; writeStream runs one session.
    expect(recorder.streamInits.map((init) => init.container)).toEqual([
      "sidecar",
      "sidecar",
      "sidecar",
    ]);
  });

  it("targets the primary when container is omitted or blank", async () => {
    const { adapter, recorder, transport } = setup(route);

    await transport.exec({ ...base, command: ["hostname"] });
    await adapter.read({ ...base, container: "  ", path: "/tmp/a" });

    expect(recorder.unary.map((request) => request.container)).toEqual(["", ""]);
  });
});
