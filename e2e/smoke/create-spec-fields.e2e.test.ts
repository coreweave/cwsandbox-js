// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

/**
 * Live smoke for create-spec fields: workingDir, securityContext,
 * runtimeClass, ingress rules, and registered volumes.
 *
 * runtimeClass needs CWSANDBOX_SMOKE_RUNTIME_CLASS (a class the org policy
 * admits). Registered volumes need CWSANDBOX_SMOKE_VOLUME_ID (an existing
 * READY Volume the default placement pool can mount; the serverless pool
 * rejects cluster-local Volumes). The smoke mounts it read-only and never
 * creates or deletes Volumes.
 */

import type { SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import {
  logProcessResult,
  smokeConfig,
  testTimeoutMs,
  waitUntilListCondition,
  withDedicatedTaggedSandbox,
} from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const runtimeClass = process.env["CWSANDBOX_SMOKE_RUNTIME_CLASS"]?.trim() || undefined;
const volumeId = process.env["CWSANDBOX_SMOKE_VOLUME_ID"]?.trim() || undefined;
const maxLifetimeSeconds = 300;

describeWithCredentials("live create-spec fields smoke", { sequential: true }, () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "applies workingDir and securityContext to the primary container",
    async () => {
      await withDedicatedTaggedSandbox(
        client,
        {
          create: (tag) =>
            client.create({
              maxLifetimeSeconds,
              securityContext: { runAsGroup: 1000, runAsUser: 1000 },
              tags: [tag],
              workingDir: "/tmp",
            }),
        },
        async (sandbox) => {
          console.log(`Started sandbox: ${sandbox.sandboxId}`);
          const pwd = await sandbox.exec(["pwd"]);
          logProcessResult("pwd", pwd);
          expect(pwd.stdout.trim()).toBe("/tmp");

          const ids = await sandbox.exec(["sh", "-c", "id -u; id -g"]);
          logProcessResult("id", ids);
          expect(ids.stdout.trim().split("\n")).toEqual(["1000", "1000"]);
        },
      );
    },
    testTimeoutMs,
  );

  it.skipIf(runtimeClass === undefined)(
    "starts with a pinned runtimeClass",
    async () => {
      await withDedicatedTaggedSandbox(
        client,
        {
          create: (tag) => client.create({ maxLifetimeSeconds, runtimeClass, tags: [tag] }),
          waitUntilRunning: true,
        },
        async (sandbox) => {
          console.log(`Started sandbox with runtimeClass ${runtimeClass}: ${sandbox.sandboxId}`);
          await expect(sandbox.getStatus()).resolves.toBe("running");
        },
      );
    },
    testTimeoutMs,
  );

  it(
    "starts with ingress rules for a CUSTOM service",
    async () => {
      await withDedicatedTaggedSandbox(
        client,
        {
          create: (tag) =>
            client.create({
              maxLifetimeSeconds,
              network: {
                ingress: [{ ports: [{ port: 8000 }], tenant: "same_org" }],
              },
              services: [{ port: 8000, visibility: "custom" }],
              tags: [tag],
            }),
          waitUntilRunning: true,
        },
        async (sandbox) => {
          console.log(`Started sandbox with ingress: ${sandbox.sandboxId}`);
          await expect(sandbox.getStatus()).resolves.toBe("running");
        },
      );
    },
    testTimeoutMs,
  );

  it.skipIf(volumeId === undefined)(
    "mounts a registered volume read-only and lists by volumeIds",
    async () => {
      const id = volumeId ?? "";
      await withDedicatedTaggedSandbox(
        client,
        {
          create: (tag) =>
            client.create({
              maxLifetimeSeconds,
              tags: [tag],
              volumes: [{ mountPath: "/data", name: "data", readOnly: true, volumeId: id }],
            }),
        },
        async (sandbox) => {
          console.log(`Started sandbox with volume ${id}: ${sandbox.sandboxId}`);
          const mount = await sandbox.exec(["sh", "-c", "test -d /data && ! touch /data/.probe"]);
          logProcessResult("read-only mount", mount);
          expect(mount.exitCode).toBe(0);

          const listed = await waitUntilListCondition(client, {
            expectedSandboxIds: [sandbox.sandboxId],
            listOptions: { tags: [...sandbox.tags], volumeIds: [id] },
            pollTimeoutMs: 30_000,
          });
          expect(listed).toEqual([sandbox.sandboxId]);
        },
      );
    },
    testTimeoutMs,
  );
});
