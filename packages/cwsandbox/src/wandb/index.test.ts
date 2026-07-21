// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SandboxClient } from "../client.js";
import { CWSandboxConfigurationError } from "../errors.js";
import { parseWandbApiKeyFromNetrc, resolveWandbApiKey } from "../integrations/wandb/auth.js";
import { createSandboxClient, createSandboxClientFromEnv, toWandbMetadata } from "./index.js";

const SOURCE_TEST_VERSION = "unknown";

describe("W&B wrapper entrypoint", () => {
  it("creates clients with W&B-native factory names", () => {
    const client = createSandboxClient({
      apiKey: "wandb-key",
      baseUrl: "https://sandbox.example.com/",
    });

    expect(client).toBeInstanceOf(SandboxClient);
  });

  it("creates clients from W&B environment variables", () => {
    const client = createSandboxClientFromEnv({
      WANDB_API_KEY: "wandb-key",
      WANDB_ENTITY: "team",
      WANDB_PROJECT: "project",
      WANDB_SANDBOX_BASE_URL: "https://sandbox.example.com/",
    });

    expect(client).toBeInstanceOf(SandboxClient);
  });

  it("does not use CWSANDBOX_API_KEY as W&B credentials", () => {
    expect(() =>
      createSandboxClient({
        env: {
          CWSANDBOX_API_KEY: "coreweave-key",
        },
        netrcPath: join(tmpdir(), "missing-wandb-wrapper-netrc"),
      }),
    ).toThrow(CWSandboxConfigurationError);
  });

  it("exports W&B metadata helpers", () => {
    expect(toWandbMetadata({ apiKey: "wandb-key", env: {} })).toEqual({
      "x-cwsandbox-client-version": SOURCE_TEST_VERSION,
      "x-sandbox-integration": "js-sdk",
      "x-wandb-api-key": "wandb-key",
      "x-wandb-sdk-version": SOURCE_TEST_VERSION,
    });
  });

  it("builds W&B gateway metadata from explicit options", () => {
    expect(
      toWandbMetadata({
        apiKey: "wandb-key",
        entity: "team",
        env: {},
        project: "project",
      }),
    ).toEqual({
      "x-cwsandbox-client-version": SOURCE_TEST_VERSION,
      "x-entity-id": "team",
      "x-project-name": "project",
      "x-sandbox-integration": "js-sdk",
      "x-wandb-api-key": "wandb-key",
      "x-wandb-sdk-version": SOURCE_TEST_VERSION,
    });
  });

  it("resolves W&B credentials with explicit options before env and netrc", () => {
    const netrcPath = writeNetrc("machine api.wandb.ai login user password netrc-key");

    try {
      expect(
        resolveWandbApiKey({
          apiKey: "explicit-key",
          env: { WANDB_API_KEY: "env-key" },
          netrcPath,
        }),
      ).toBe("explicit-key");
    } finally {
      rmSync(netrcPath, { force: true });
    }
  });

  it("resolves W&B credentials from WANDB_API_KEY before netrc", () => {
    const netrcPath = writeNetrc("machine api.wandb.ai login user password netrc-key");

    try {
      expect(resolveWandbApiKey({ env: { WANDB_API_KEY: "env-key" }, netrcPath })).toBe("env-key");
    } finally {
      rmSync(netrcPath, { force: true });
    }
  });

  it("resolves W&B credentials from api.wandb.ai netrc entries", () => {
    const netrcPath = writeNetrc("machine api.wandb.ai login user password netrc-key");

    try {
      expect(resolveWandbApiKey({ env: {}, netrcPath })).toBe("netrc-key");
    } finally {
      rmSync(netrcPath, { force: true });
    }
  });

  it("resolves W&B credentials from wandb.ai netrc entries", () => {
    expect(parseWandbApiKeyFromNetrc("machine wandb.ai login user password netrc-key")).toBe(
      "netrc-key",
    );
  });

  it("ignores blank W&B credential values", () => {
    const netrcPath = writeNetrc("machine api.wandb.ai login user password netrc-key");

    try {
      expect(resolveWandbApiKey({ apiKey: "   ", env: { WANDB_API_KEY: " " }, netrcPath })).toBe(
        "netrc-key",
      );
    } finally {
      rmSync(netrcPath, { force: true });
    }
  });
});

function writeNetrc(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cwsandbox-js-netrc-"));
  const path = join(dir, ".netrc");
  writeFileSync(path, contents);
  return path;
}
