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
} from "../../../internal/error-info.js";
import { parseStatusDetailsFromMetadata } from "../error-info.js";
import { statusDetailsMeta } from "./status-details.js";

describe("statusDetailsMeta round-trip", () => {
  it("packs ErrorInfo reason and metadata", () => {
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

  it("defaults domain to cwsandbox.com", () => {
    const parsed = parseStatusDetailsFromMetadata(
      statusDetailsMeta({
        errorInfos: [{ reason: CWSANDBOX_SANDBOX_NOT_FOUND }],
      }),
    );

    expect(parsed?.reason).toBe(CWSANDBOX_SANDBOX_NOT_FOUND);
    expect(parsed?.domain).toBe(CWSANDBOX_ERROR_DOMAIN);
    expect(parsed?.metadata).toEqual({});
  });

  it("packs RetryInfo seconds into retryDelayMs", () => {
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

  it("packs untrusted domains without changing parse behavior", () => {
    const parsed = parseStatusDetailsFromMetadata(
      statusDetailsMeta({
        errorInfos: [
          {
            domain: "evil.example.com",
            reason: CWSANDBOX_SANDBOX_NOT_FOUND,
          },
        ],
      }),
    );

    expect(parsed?.reason).toBe(CWSANDBOX_SANDBOX_NOT_FOUND);
    expect(parsed?.domain).toBe("evil.example.com");
  });

  it("packs nanos into retryDelayMs", () => {
    const parsed = parseStatusDetailsFromMetadata(
      statusDetailsMeta({
        errorInfos: [{ reason: CWSANDBOX_BACKEND_UNAVAILABLE }],
        retryInfos: [{ retryNanos: 500_000_000 }],
      }),
    );

    expect(parsed?.retryDelayMs).toBe(500);
  });
});
