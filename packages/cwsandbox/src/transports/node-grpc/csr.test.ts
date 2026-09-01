// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { createPrivateKey, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { generateP256Csr } from "./csr.js";

describe("generateP256Csr", () => {
  it("emits an empty-subject P-256 PKCS#10 CSR and PKCS#8 key", () => {
    const { csrDer, privateKeyPem } = generateP256Csr();

    expect(csrDer[0]).toBe(0x30);
    expect(csrDer.byteLength).toBeGreaterThan(80);
    expect(Buffer.from(privateKeyPem).toString("utf8")).toContain("BEGIN PRIVATE KEY");

    const infoAndAlg = readCertificationRequestInfo(Buffer.from(csrDer));
    expect(infoAndAlg.subjectDer.equals(Buffer.from([0x30, 0x00]))).toBe(true);

    const key = createPrivateKey(privateKeyPem);
    expect(verify("sha256", infoAndAlg.certificationRequestInfo, key, infoAndAlg.signature)).toBe(
      true,
    );
  });
});

function readCertificationRequestInfo(csrDer: Buffer): {
  readonly certificationRequestInfo: Buffer;
  readonly signature: Buffer;
  readonly subjectDer: Buffer;
} {
  const csr = readSequence(csrDer, 0);
  const info = readSequence(csr.body, 0);
  const version = info.body.subarray(0, 3);
  expect(version.equals(Buffer.from([0x02, 0x01, 0x00]))).toBe(true);
  const subject = readSequence(info.body, 3);
  const signature = readBitString(
    csr.body,
    info.consumed + readSequence(csr.body, info.consumed).consumed,
  );

  return {
    certificationRequestInfo: info.raw,
    signature,
    subjectDer: subject.raw,
  };
}

function readSequence(
  bytes: Buffer,
  offset: number,
): { readonly body: Buffer; readonly consumed: number; readonly raw: Buffer } {
  expect(bytes[offset]).toBe(0x30);
  const length = readLength(bytes, offset + 1);
  const header = 1 + length.size;
  const raw = bytes.subarray(offset, offset + header + length.value);
  return {
    body: bytes.subarray(offset + header, offset + header + length.value),
    consumed: header + length.value,
    raw,
  };
}

function readBitString(bytes: Buffer, offset: number): Buffer {
  expect(bytes[offset]).toBe(0x03);
  const length = readLength(bytes, offset + 1);
  const header = 1 + length.size;
  const body = bytes.subarray(offset + header, offset + header + length.value);
  expect(body[0]).toBe(0x00);
  return body.subarray(1);
}

function readLength(
  bytes: Buffer,
  offset: number,
): { readonly size: number; readonly value: number } {
  const first = bytes[offset];
  if (first === undefined) {
    throw new Error("CSR DER is truncated.");
  }
  if (first < 0x80) {
    return { size: 1, value: first };
  }
  if (first === 0x81) {
    const value = bytes[offset + 1];
    if (value === undefined) {
      throw new Error("CSR DER is truncated.");
    }
    return { size: 2, value };
  }
  if (first === 0x82) {
    const high = bytes[offset + 1];
    const low = bytes[offset + 2];
    if (high === undefined || low === undefined) {
      throw new Error("CSR DER is truncated.");
    }
    return { size: 3, value: (high << 8) | low };
  }
  throw new Error("Unsupported CSR DER length.");
}
