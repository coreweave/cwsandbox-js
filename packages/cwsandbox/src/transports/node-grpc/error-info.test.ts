// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import {
  CWSANDBOX_BACKEND_UNAVAILABLE,
  CWSANDBOX_ERROR_DOMAIN,
  CWSANDBOX_FILE_NOT_FOUND,
  CWSANDBOX_FILE_TOO_LARGE,
  CWSANDBOX_SANDBOX_NOT_FOUND,
} from "../../internal/error-info.js";
import { parseStatusDetailsFromMetadata } from "./error-info.js";

// google.rpc.Status with ErrorInfo(CWSANDBOX_FILE_TOO_LARGE) from a live-shaped payload.
const FILE_TOO_LARGE_STATUS_B64 =
  "CAkSOGZpbGUgcGF5bG9hZCBleGNlZWRzIGNvbmZpZ3VyZWQgbWF4LWZpbGUtb3BlcmF0aW9uLWJ5dGVzGrkBCih0eXBlLmdvb2dsZWFwaXMuY29tL2dvb2dsZS5ycGMuRXJyb3JJbmZvEowBChhDV1NBTkRCT1hfRklMRV9UT09fTEFSR0USDWN3c2FuZGJveC5jb20aEgoIZmlsZXBhdGgSBi90bXAveBoaCg5tYXhfc2l6ZV9ieXRlcxIIMzM1NTQ0MzIaFgoKc2l6ZV9ieXRlcxIINjcxMDg4NjQaGQoJb3BlcmF0aW9uEgxSZXRyaWV2ZUZpbGU=";

const SANDBOX_NOT_FOUND_B64 =
  "CAISBHRlc3QaWAoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxIsChtDV1NBTkRCT1hfU0FOREJPWF9OT1RfRk9VTkQSDWN3c2FuZGJveC5jb20=";

const BACKEND_UNAVAILABLE_WITH_RETRY_B64 =
  "CAISBHRlc3QaWgoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxIuCh1DV1NBTkRCT1hfQkFDS0VORF9VTkFWQUlMQUJMRRINY3dzYW5kYm94LmNvbRowCih0eXBlLmdvb2dsZWFwaXMuY29tL2dvb2dsZS5ycGMuUmV0cnlJbmZvEgQKAggC";

const EMPTY_RETRY_THEN_VALID_B64 =
  "CAISBHRlc3QaWgoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxIuCh1DV1NBTkRCT1hfQkFDS0VORF9VTkFWQUlMQUJMRRINY3dzYW5kYm94LmNvbRosCih0eXBlLmdvb2dsZWFwaXMuY29tL2dvb2dsZS5ycGMuUmV0cnlJbmZvEgAaMAoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLlJldHJ5SW5mbxIECgIIBw==";

const EMPTY_REASON_THEN_VALID_B64 =
  "CAISBHRlc3QaPQoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxIRCgASDWN3c2FuZGJveC5jb20aVQoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxIpChhDV1NBTkRCT1hfRklMRV9OT1RfRk9VTkQSDWN3c2FuZGJveC5jb20=";

const ZERO_RETRY_B64 =
  "CAISBHRlc3QaWgoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxIuCh1DV1NBTkRCT1hfQkFDS0VORF9VTkFWQUlMQUJMRRINY3dzYW5kYm94LmNvbRouCih0eXBlLmdvb2dsZWFwaXMuY29tL2dvb2dsZS5ycGMuUmV0cnlJbmZvEgIKAA==";

describe("parseStatusDetailsFromMetadata", () => {
  it("parses ErrorInfo reason and metadata from grpc-status-details-bin", () => {
    const parsed = parseStatusDetailsFromMetadata({
      "grpc-status-details-bin": FILE_TOO_LARGE_STATUS_B64,
    });

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
    const parsed = parseStatusDetailsFromMetadata({
      "grpc-status-details-bin": SANDBOX_NOT_FOUND_B64,
    });

    expect(parsed?.reason).toBe(CWSANDBOX_SANDBOX_NOT_FOUND);
    expect(parsed?.domain).toBe(CWSANDBOX_ERROR_DOMAIN);
    expect(parsed?.metadata).toEqual({});
  });

  it("parses RetryInfo retry delay as milliseconds", () => {
    const parsed = parseStatusDetailsFromMetadata({
      "grpc-status-details-bin": BACKEND_UNAVAILABLE_WITH_RETRY_B64,
    });

    expect(parsed?.reason).toBe(CWSANDBOX_BACKEND_UNAVAILABLE);
    expect(parsed?.retryDelayMs).toBe(2000);
  });

  it("skips empty RetryInfo so a later RetryInfo can win", () => {
    const parsed = parseStatusDetailsFromMetadata({
      "grpc-status-details-bin": EMPTY_RETRY_THEN_VALID_B64,
    });

    expect(parsed?.reason).toBe(CWSANDBOX_BACKEND_UNAVAILABLE);
    expect(parsed?.retryDelayMs).toBe(7000);
  });

  it("skips empty ErrorInfo reason so a later reason can win", () => {
    const parsed = parseStatusDetailsFromMetadata({
      "grpc-status-details-bin": EMPTY_REASON_THEN_VALID_B64,
    });

    expect(parsed?.reason).toBe(CWSANDBOX_FILE_NOT_FOUND);
  });

  it("preserves explicit zero retry delay", () => {
    const parsed = parseStatusDetailsFromMetadata({
      "grpc-status-details-bin": ZERO_RETRY_B64,
    });

    expect(parsed?.retryDelayMs).toBe(0);
  });

  it("returns undefined for malformed details", () => {
    expect(
      parseStatusDetailsFromMetadata({
        "grpc-status-details-bin": "not-valid-protobuf!!!",
      }),
    ).toBeUndefined();
  });

  it("skips a malformed leading entry and parses a later valid one", () => {
    const parsed = parseStatusDetailsFromMetadata({
      "grpc-status-details-bin": ["not-valid-protobuf!!!", SANDBOX_NOT_FOUND_B64],
    });

    expect(parsed?.reason).toBe(CWSANDBOX_SANDBOX_NOT_FOUND);
  });
});
