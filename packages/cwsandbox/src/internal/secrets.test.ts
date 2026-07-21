// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSandboxValidationError } from "../errors.js";
import { MAX_SECRETS, normalizeSecrets, validateSecrets } from "./secrets.js";

describe("normalizeSecrets", () => {
  it("defaults envVar to name and field to empty string", () => {
    expect(normalizeSecrets([{ store: "wandb-team-secrets", name: "HF_TOKEN" }])).toEqual([
      {
        envVar: "HF_TOKEN",
        field: "",
        name: "HF_TOKEN",
        store: "wandb-team-secrets",
      },
    ]);
  });

  it("preserves explicit envVar and field", () => {
    expect(
      normalizeSecrets([
        {
          envVar: "DB_PASS",
          field: "password",
          name: "db-credentials",
          store: "wandb-team-secrets",
        },
      ]),
    ).toEqual([
      {
        envVar: "DB_PASS",
        field: "password",
        name: "db-credentials",
        store: "wandb-team-secrets",
      },
    ]);
  });

  it("returns an empty list when secrets is omitted", () => {
    expect(normalizeSecrets(undefined)).toEqual([]);
  });
});

describe("validateSecrets", () => {
  it("accepts valid secrets", () => {
    expect(() =>
      validateSecrets([
        { store: "wandb-team-secrets", name: "HF_TOKEN" },
        {
          envVar: "DB_PASS",
          field: "password",
          name: "db-credentials",
          store: "wandb-team-secrets",
        },
      ]),
    ).not.toThrow();
  });

  it("rejects empty store and name", () => {
    expect(() => validateSecrets([{ store: "", name: "HF_TOKEN" }])).toThrow(
      CWSandboxValidationError,
    );
    expect(() => validateSecrets([{ store: "wandb-team-secrets", name: "" }])).toThrow(
      CWSandboxValidationError,
    );
  });

  it("rejects empty envVar when provided", () => {
    expect(() =>
      validateSecrets([{ envVar: "", name: "HF_TOKEN", store: "wandb-team-secrets" }]),
    ).toThrow(CWSandboxValidationError);
  });

  it("rejects blank field whitespace", () => {
    expect(() =>
      validateSecrets([{ field: "   ", name: "HF_TOKEN", store: "wandb-team-secrets" }]),
    ).toThrow(CWSandboxValidationError);
  });

  it("allows omitted or empty field", () => {
    expect(() =>
      validateSecrets([
        { name: "A", store: "wandb-team-secrets" },
        { field: "", name: "B", store: "wandb-team-secrets" },
      ]),
    ).not.toThrow();
  });

  it("rejects duplicate envVar targets", () => {
    expect(() =>
      validateSecrets([
        { store: "wandb-team-secrets", name: "HF_TOKEN" },
        { envVar: "HF_TOKEN", name: "OTHER", store: "other-store" },
      ]),
    ).toThrow(/duplicate envVar/);
  });

  it("rejects collisions with environmentVariables", () => {
    expect(() =>
      validateSecrets([{ store: "wandb-team-secrets", name: "HF_TOKEN" }], {
        HF_TOKEN: "plaintext",
      }),
    ).toThrow(/conflicts with environmentVariables/);
  });

  it("rejects more than the gateway secret cap", () => {
    const secrets = Array.from({ length: MAX_SECRETS + 1 }, (_, index) => ({
      name: `SECRET_${index}`,
      store: "wandb-team-secrets",
    }));

    expect(() => validateSecrets(secrets)).toThrow(/50 entries or fewer/);
  });
});
