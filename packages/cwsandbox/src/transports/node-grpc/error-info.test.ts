// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { RpcError } from "@protobuf-ts/runtime-rpc";
import { describe, expect, it } from "vitest";

import { CWSandboxTransportError } from "../../errors.js";
import {
  CWSANDBOX_BACKEND_UNAVAILABLE,
  CWSANDBOX_ERROR_DOMAIN,
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_TOO_LARGE,
  CWSANDBOX_SANDBOX_NOT_FOUND,
} from "../../internal/error-info.js";
import { parseStatusDetailsFromMetadata } from "./error-info.js";
import { mapGrpcError } from "./errors.js";
import { statusDetailsMeta } from "./test/status-details.js";

describe("parseStatusDetailsFromMetadata", () => {
  it("parses ErrorInfo reason and metadata from grpc-status-details-bin", () => {
    const parsed = parseStatusDetailsFromMetadata(
      statusDetailsMeta({
        errorInfos: [
          {
            reason: CWSANDBOX_FILE_TOO_LARGE,
            metadata: {
              filepath: "/tmp/x",
              max_size_bytes: "33554432",
              operation: "RetrieveFile",
              size_bytes: "67108864",
            },
          },
        ],
      }),
    );

    expect(parsed).toEqual({
      domain: CWSANDBOX_ERROR_DOMAIN,
      metadata: {
        filepath: "/tmp/x",
        max_size_bytes: "33554432",
        operation: "RetrieveFile",
        size_bytes: "67108864",
      },
      reason: CWSANDBOX_FILE_TOO_LARGE,
    });
  });

  it("parses sandbox-not-found reasons", () => {
    const parsed = parseStatusDetailsFromMetadata(
      statusDetailsMeta({
        errorInfos: [{ reason: CWSANDBOX_SANDBOX_NOT_FOUND }],
      }),
    );

    expect(parsed?.reason).toBe(CWSANDBOX_SANDBOX_NOT_FOUND);
    expect(parsed?.domain).toBe(CWSANDBOX_ERROR_DOMAIN);
    expect(parsed?.metadata).toEqual({});
  });

  it("parses RetryInfo retry delay as milliseconds", () => {
    const parsed = parseStatusDetailsFromMetadata(
      statusDetailsMeta({
        errorInfos: [{ reason: CWSANDBOX_BACKEND_UNAVAILABLE }],
        retryInfos: [{ retrySeconds: 2 }],
      }),
    );

    expect(parsed?.reason).toBe(CWSANDBOX_BACKEND_UNAVAILABLE);
    expect(parsed?.retryDelayMs).toBe(2000);
  });

  it("skips empty RetryInfo so a later RetryInfo can win", () => {
    const parsed = parseStatusDetailsFromMetadata(
      statusDetailsMeta({
        errorInfos: [{ reason: CWSANDBOX_BACKEND_UNAVAILABLE }],
        retryInfos: [{}, { retrySeconds: 7 }],
      }),
    );

    expect(parsed?.reason).toBe(CWSANDBOX_BACKEND_UNAVAILABLE);
    expect(parsed?.retryDelayMs).toBe(7000);
  });

  it("skips empty ErrorInfo reason so a later reason can win", () => {
    const parsed = parseStatusDetailsFromMetadata(
      statusDetailsMeta({
        errorInfos: [{ reason: "" }, { reason: CWSANDBOX_FILE_NOT_FOUND }],
      }),
    );

    expect(parsed?.reason).toBe(CWSANDBOX_FILE_NOT_FOUND);
  });

  it("preserves explicit zero retry delay", () => {
    const parsed = parseStatusDetailsFromMetadata(
      statusDetailsMeta({
        errorInfos: [{ reason: CWSANDBOX_BACKEND_UNAVAILABLE }],
        retryInfos: [{ retrySeconds: 0 }],
      }),
    );

    expect(parsed?.retryDelayMs).toBe(0);
  });

  it("surfaces BadRequest field violations alongside ErrorInfo on mapped errors", () => {
    const cause = new RpcError(
      "invalid request",
      "INVALID_ARGUMENT",
      statusDetailsMeta({
        errorInfos: [{ reason: "CWSANDBOX_INVALID_REQUEST" }],
        badRequests: [
          {
            fieldViolations: [
              { field: "resources.cpu", description: "must be at most 64" },
              { field: "resources.memory", localizedMessage: "too large" },
              { field: "", description: "" },
            ],
          },
          { fieldViolations: [{ field: "image", reason: "IMAGE_REQUIRED" }] },
        ],
      }),
    );

    const error = mapGrpcError(cause, { operation: "Start sandbox" });

    expect(error).toBeInstanceOf(CWSandboxTransportError);
    const transportError = error as CWSandboxTransportError;
    expect(transportError.reason).toBe("CWSANDBOX_INVALID_REQUEST");
    expect(transportError.fieldViolations).toEqual([
      { field: "resources.cpu", description: "must be at most 64" },
      { field: "resources.memory", description: "too large" },
      { field: "image", description: "IMAGE_REQUIRED" },
    ]);
  });

  it("parses BadRequest without ErrorInfo or RetryInfo", () => {
    const parsed = parseStatusDetailsFromMetadata(
      statusDetailsMeta({
        badRequests: [{ fieldViolations: [{ field: "name", description: "required" }] }],
      }),
    );

    expect(parsed).toEqual({
      domain: "",
      metadata: {},
      fieldViolations: [{ field: "name", description: "required" }],
    });
  });

  it("returns undefined for malformed details", () => {
    expect(
      parseStatusDetailsFromMetadata({
        "grpc-status-details-bin": "not-valid-protobuf!!!",
      }),
    ).toBeUndefined();
  });

  it("skips a malformed leading entry and parses a later valid one", () => {
    const valid = statusDetailsMeta({
      errorInfos: [{ reason: CWSANDBOX_SANDBOX_NOT_FOUND }],
    })["grpc-status-details-bin"];

    const parsed = parseStatusDetailsFromMetadata({
      "grpc-status-details-bin": ["not-valid-protobuf!!!", valid],
    });

    expect(parsed?.reason).toBe(CWSANDBOX_SANDBOX_NOT_FOUND);
  });
});
