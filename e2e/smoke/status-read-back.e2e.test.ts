// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * Live smoke for status read-back fields and runFromFile request IDs.
 */

import { randomUUID } from "node:crypto";

import { CWSandboxTransportError, type Sandbox, type SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import {
  DNS_EGRESS_EXACT,
  dnsEgressSmokeTimeoutMs,
  rejectAndNarrow,
  shouldSkipDnsEgress,
  smokeConfig,
  startOptionsForDnsNameEgress,
  uniqueSmokeTag,
} from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const fromFileTestTimeoutMs = 180_000;
const compose = (marker: string): Uint8Array =>
  new TextEncoder().encode(`services:
  main:
    image: alpine:3.20
    command: ["sleep", "3600"]
    labels:
      marker: "${marker}"
`);

if (!smokeConfig.hasCredentials) {
  console.log("[read-back-smoke] skip: CWSANDBOX_API_KEY is not set.");
}

describeWithCredentials("live status read-back smoke", { sequential: true }, () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "echoes effective egress, runtime class, container statuses, and handle state",
    async (ctx) => {
      const tag = uniqueSmokeTag();
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await client.create({ ...startOptionsForDnsNameEgress(), tags: [tag] });
      } catch (error) {
        if (shouldSkipDnsEgress(error)) {
          ctx.skip(`fleet cannot admit DNS-name egress: ${String(error)}`);
          return;
        }
        throw error;
      }

      try {
        expect(sandbox.effectiveEgress).toEqual(
          expect.arrayContaining([expect.objectContaining({ dnsName: DNS_EGRESS_EXACT })]),
        );
        expect(sandbox.effectiveRuntimeClass).toEqual(expect.any(String));
        expect(sandbox.effectiveRuntimeClass).not.toBe("");
        expect(sandbox.containerStatuses).toEqual(
          expect.arrayContaining([expect.objectContaining({ status: "running" })]),
        );

        const before = sandbox.statusUpdatedAt;
        expect(before).toBeInstanceOf(Date);
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        await sandbox.inspect();
        expect(sandbox.statusUpdatedAt?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);

        await sandbox.exec(["true"]);
        await sandbox.commands.run(["false"]);
        expect(sandbox.execStats).toEqual({
          execCount: 2,
          execCompletedOk: 1,
          execCompletedNonzero: 1,
          execFailures: 0,
        });

        const listed = (await client.listAll({ tags: [tag] }))[0];
        expect(listed?.sandboxId).toBe(sandbox.sandboxId);
        expect(listed?.effectiveEgress).toEqual(sandbox.effectiveEgress);
        expect(listed?.effectiveRuntimeClass).toBe(sandbox.effectiveRuntimeClass);
        const discovered = await client.fromId(sandbox.sandboxId);
        expect(discovered.effectiveEgress).toEqual(sandbox.effectiveEgress);
        expect(discovered.execStats?.execCount).toBe(0);
      } finally {
        await sandbox.stop({ missingOk: true });
      }
    },
    dnsEgressSmokeTimeoutMs,
  );

  it(
    "replays runFromFile with the same requestId and rejects different bytes",
    async () => {
      const requestId = randomUUID();
      const options = {
        maxLifetimeSeconds: 300,
        primaryService: "main",
        requestId,
        tags: [uniqueSmokeTag()],
        waitUntilRunning: false,
      };
      let first: Sandbox | undefined;
      try {
        first = await client.runFromFile(compose("a"), options);
        const replay = await client.runFromFile(compose("a"), options);
        expect(replay.sandboxId).toBe(first.sandboxId);

        const conflict = await rejectAndNarrow(
          () => client.runFromFile(compose("b"), options),
          (error): error is CWSandboxTransportError => error instanceof CWSandboxTransportError,
        );
        expect(conflict.reason).toBe("CWSANDBOX_REQUEST_ID_CONFLICT");
      } finally {
        await first?.stop({ missingOk: true });
      }
    },
    fromFileTestTimeoutMs,
  );
});
