// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Public HTTPS endpoint that requires a platform share token.
 *
 * Demonstrates:
 * - endpoint.auth "share_token" on a PUBLIC HTTPS service
 * - create-only sandbox.endpointShareToken (Get / fromId omit it)
 * - caller-attached X-Sandbox-Share-Token (SDK does not fetch for you)
 * - log URL + "token received" only — never the raw token
 */

import { CWSandboxTransportError } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();

  try {
    await client.withSandbox(
      ["python", "-m", "http.server", "8000"],
      async (sandbox) => {
        const url = sandbox.serviceUrls?.[0]?.url;
        const token = sandbox.endpointShareToken;
        if (!url || !token) {
          throw new Error(
            "Share-token URL/token missing on create. Delete and recreate; Get/fromId cannot recover the token.",
          );
        }

        console.log(`Sandbox: ${sandbox.sandboxId}`);
        console.log(`URL: ${url}; share token: received`);
        console.log("fromId / inspect omit the token; this handle keeps the create-time value.");

        const ok = await fetch(url, {
          headers: { "X-Sandbox-Share-Token": token },
        });
        console.log(`Authenticated GET: ${String(ok.status)}`);

        const denied = await fetch(url);
        console.log(`Unauthenticated GET: ${String(denied.status)}`);
      },
      {
        services: [
          {
            endpoint: { auth: "share_token", kind: "https" },
            name: "http",
            port: 8000,
            visibility: "public",
          },
        ],
        tags: ["example", "example-https-share-token"],
      },
    );
  } catch (error) {
    if (
      error instanceof CWSandboxTransportError &&
      error.reason === "CWSANDBOX_HTTPS_SHARE_TOKEN_NOT_SUPPORTED"
    ) {
      throw new Error(`No runner advertises share-token HTTPS. ${String(error)}`);
    }
    throw error;
  }
}

await main();
