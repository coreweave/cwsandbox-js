// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { generateKeyPairSync, sign } from "node:crypto";

/** Empty-subject P-256 PKCS#10 CSR plus the PKCS#8 PEM private key. */
export interface GeneratedCsr {
  readonly csrDer: Uint8Array;
  readonly privateKeyPem: Buffer;
}

const ECDSA_WITH_SHA256_OID = Buffer.from([
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02,
]);

export function generateP256Csr(): GeneratedCsr {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  const certificationRequestInfo = encodeSequence(
    Buffer.from([0x02, 0x01, 0x00]),
    Buffer.from([0x30, 0x00]),
    spki,
    Buffer.from([0xa0, 0x00]),
  );
  const signature = sign("sha256", certificationRequestInfo, privateKey);
  const csrDer = encodeSequence(
    certificationRequestInfo,
    encodeSequence(ECDSA_WITH_SHA256_OID),
    encodeBitString(signature),
  );

  return {
    csrDer: new Uint8Array(csrDer),
    privateKeyPem: Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" })),
  };
}

function encodeSequence(...parts: readonly Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30]), encodeLength(body.length), body]);
}

function encodeBitString(bytes: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([0x00]), bytes]);
  return Buffer.concat([Buffer.from([0x03]), encodeLength(body.length), body]);
}

function encodeLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  if (length < 0x100) {
    return Buffer.from([0x81, length]);
  }
  if (length < 0x10000) {
    return Buffer.from([0x82, length >> 8, length & 0xff]);
  }
  throw new Error("CSR DER length is too large.");
}
