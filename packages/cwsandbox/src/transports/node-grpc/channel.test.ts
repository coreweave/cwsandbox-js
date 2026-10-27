// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { once } from "node:events";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createGrpcClients } from "./channel.js";

const MIN_WINDOW_BYTES = 4 * 1024 * 1024;

describe("createGrpcClients", () => {
  let server: http2.Http2Server | undefined;

  afterEach(async () => {
    server?.close();
    server = undefined;
  });

  it("advertises a large HTTP/2 receive window for the stream and the connection", async () => {
    server = http2.createServer();
    const sessionSeen = once(server, "session") as Promise<[http2.ServerHttp2Session]>;
    server.on("stream", (stream) => {
      stream.respond(
        { ":status": 200, "content-type": "application/grpc", "grpc-status": "12" },
        { endStream: true },
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const { client } = createGrpcClients({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${port}`,
    });
    const call = client.getSandbox({ sandboxId: "sandbox-1" }).response.catch(() => undefined);
    const [session] = await sessionSeen;
    await call;

    // The HTTP/2 default is 64 KiB, which caps a large read at 64 KiB per round trip.
    expect(session.remoteSettings.initialWindowSize).toBeGreaterThanOrEqual(MIN_WINDOW_BYTES);
    expect(session.state.remoteWindowSize).toBeGreaterThanOrEqual(MIN_WINDOW_BYTES);
  });
});
