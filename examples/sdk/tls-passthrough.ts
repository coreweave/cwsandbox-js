// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Public TLS passthrough endpoint.
 *
 * Demonstrates:
 * - endpoint.kind "tls_passthrough" on a PUBLIC service
 * - inspect().serviceAddresses is host:port assignment, not app-ready
 * - fromId and list echo the same address
 * - SNI GET uses the address host; the workload owns the cert
 */

import { Buffer } from "node:buffer";
import https from "node:https";

import { CWSandboxTransportError } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

const TLS_BODY = "product-tls-ok";
const TLS_SCRIPT = `
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const https = require("node:https");
const body = "product-tls-ok";
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", "/tmp/tls.key", "-out", "/tmp/tls.crt",
  "-days", "1", "-subj", "/CN=tls-probe",
]);
https.createServer(
  { cert: readFileSync("/tmp/tls.crt"), key: readFileSync("/tmp/tls.key") },
  (_request, response) => {
    response.writeHead(200, {
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "text/plain",
    });
    response.end(body);
  },
).listen(8443, "0.0.0.0");
`;

function splitHostPort(address: string): readonly [string, string] {
  const separator = address.lastIndexOf(":");
  if (separator <= 0 || separator === address.length - 1) {
    throw new Error(`TLS address must be host:port, got ${JSON.stringify(address)}`);
  }
  return [address.slice(0, separator), address.slice(separator + 1)];
}

function tlsGetOnce(address: string): Promise<string> {
  const [host, portText] = splitHostPort(address);
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        hostname: host,
        port: Number(portText),
        rejectUnauthorized: false,
        servername: host,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );
    request.on("error", reject);
  });
}

async function tlsGet(address: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await tlsGetOnce(address);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
    }
  }
  throw new Error(`TLS GET ${address} failed: ${String(lastError)}`);
}

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  try {
    await client.withSandbox(
      ["node", "-e", TLS_SCRIPT],
      async (sandbox) => {
        const created = sandbox.serviceAddresses?.[0];
        console.log(`Sandbox: ${sandbox.sandboxId}`);
        console.log(`Create addresses: ${JSON.stringify(sandbox.serviceAddresses)}`);
        if (created === undefined) {
          throw new Error("Create did not fill serviceAddresses");
        }

        const fetched = await client.fromId(sandbox.sandboxId);
        console.log(`fromId addresses: ${JSON.stringify(fetched.serviceAddresses)}`);
        if (JSON.stringify(fetched.serviceAddresses) !== JSON.stringify([created])) {
          throw new Error("fromId serviceAddresses did not match Create");
        }

        const listed = await client.list({ tags: ["example-tls-passthrough"] });
        const match = listed.sandboxes.find((item) => item.sandboxId === sandbox.sandboxId);
        if (match === undefined) {
          throw new Error(`List did not return ${sandbox.sandboxId}`);
        }
        console.log(`list addresses: ${JSON.stringify(match.serviceAddresses)}`);
        if (JSON.stringify(match.serviceAddresses) !== JSON.stringify([created])) {
          throw new Error("list serviceAddresses did not match Create");
        }

        const body = await tlsGet(created.address);
        console.log(`TLS GET body: ${body}`);
        if (body !== TLS_BODY) {
          throw new Error(`expected ${JSON.stringify(TLS_BODY)}, got ${JSON.stringify(body)}`);
        }
      },
      {
        containerImage: "node:22",
        services: [
          {
            endpoint: { kind: "tls_passthrough" },
            name: "tls",
            port: 8443,
            visibility: "public",
          },
        ],
        tags: ["example", "example-tls-passthrough"],
      },
    );
  } catch (error) {
    if (
      error instanceof CWSandboxTransportError &&
      error.reason === "CWSANDBOX_TLS_PASSTHROUGH_ENDPOINTS_NOT_SUPPORTED"
    ) {
      throw new Error(`No runner advertises TLS passthrough. ${String(error)}`);
    }
    throw error;
  }
}

await main();
