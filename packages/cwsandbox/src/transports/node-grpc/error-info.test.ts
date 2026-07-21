// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { describe, expect, it } from "vitest";

import { CWSANDBOX_ERROR_DOMAIN, CWSANDBOX_FILE_TOO_LARGE } from "../../internal/error-info.js";
import { parseErrorInfoFromMetadata } from "./error-info.js";

// google.rpc.Status with ErrorInfo(CWSANDBOX_FILE_TOO_LARGE), base64 of grpc-status-details-bin.
const FILE_TOO_LARGE_STATUS_B64 =
  "CAkSOGZpbGUgcGF5bG9hZCBleGNlZWRzIGNvbmZpZ3VyZWQgbWF4LWZpbGUtb3BlcmF0aW9uLWJ5dGVzGrkBCih0eXBlLmdvb2dsZWFwaXMuY29tL2dvb2dsZS5ycGMuRXJyb3JJbmZvEowBChhDV1NBTkRCT1hfRklMRV9UT09fTEFSR0USDWN3c2FuZGJveC5jb20aEgoIZmlsZXBhdGgSBi90bXAveBoaCg5tYXhfc2l6ZV9ieXRlcxIIMzM1NTQ0MzIaFgoKc2l6ZV9ieXRlcxIINjcxMDg4NjQaGQoJb3BlcmF0aW9uEgxSZXRyaWV2ZUZpbGU=";

describe("parseErrorInfoFromMetadata", () => {
  it("parses ErrorInfo reason and metadata from grpc-status-details-bin", () => {
    const parsed = parseErrorInfoFromMetadata({
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

  it("returns undefined for malformed details", () => {
    expect(
      parseErrorInfoFromMetadata({
        "grpc-status-details-bin": "not-valid-protobuf!!!",
      }),
    ).toBeUndefined();
  });
});
