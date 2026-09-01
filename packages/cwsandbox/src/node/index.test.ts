// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { SandboxClient } from "../client.js";
import { CWSandboxConfigurationError, CWSandboxValidationError } from "../errors.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_KEEP_ALIVE_COMMAND,
  createSandboxClient,
  createSandboxClientFromEnv,
} from "./index.js";

describe("createSandboxClient", () => {
  it("creates a gRPC-backed sandbox client", () => {
    const client = createSandboxClient({
      apiKey: "test-key",
      baseUrl: "https://sandbox.example.com/",
    });

    expect(client).toBeInstanceOf(SandboxClient);
  });

  it("throws a typed configuration error when the API key is blank", () => {
    expect(() => createSandboxClient({ apiKey: "   " })).toThrow(CWSandboxConfigurationError);
  });

  it("throws a typed configuration error when the base URL is malformed", () => {
    expect(() => createSandboxClient({ apiKey: "test-key", baseUrl: "not a url" })).toThrow(
      CWSandboxConfigurationError,
    );
  });

  it("throws a typed configuration error when the base URL protocol is unsupported", () => {
    expect(() => createSandboxClient({ apiKey: "test-key", baseUrl: "ftp://example.com" })).toThrow(
      CWSandboxConfigurationError,
    );
  });

  it("rejects an unknown dataPlaneMode before opening a channel", () => {
    expect(() =>
      createSandboxClient({
        apiKey: "test-key",
        dataPlaneMode: "mtls" as never,
      }),
    ).toThrow(CWSandboxValidationError);
  });
});

describe("createSandboxClientFromEnv", () => {
  it("reads API credentials from the environment", () => {
    const client = createSandboxClientFromEnv({
      CWSANDBOX_API_KEY: "test-key",
    });

    expect(client).toBeInstanceOf(SandboxClient);
  });

  it("reads the base URL from the environment", () => {
    const client = createSandboxClientFromEnv({
      CWSANDBOX_API_KEY: "test-key",
      CWSANDBOX_BASE_URL: "https://sandbox.example.com/",
    });

    expect(client).toBeInstanceOf(SandboxClient);
  });

  it("throws a typed configuration error when the API key is missing", () => {
    expect(() => createSandboxClientFromEnv({})).toThrow(CWSandboxConfigurationError);
  });

  it("exports the default base URL for Node helpers", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.cwsandbox.com");
  });

  it("exports the default container image for Node helpers", () => {
    expect(DEFAULT_CONTAINER_IMAGE).toBe("python:3.11");
  });

  it("exports the recommended keep-alive command for multi-operation sandboxes", () => {
    expect(DEFAULT_KEEP_ALIVE_COMMAND).toEqual([
      "/bin/sh",
      "-lc",
      "trap 'exit 0' TERM INT; sleep infinity & wait",
    ]);
  });
});
