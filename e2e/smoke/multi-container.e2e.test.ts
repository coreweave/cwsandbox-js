// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import type { Container, SandboxClient } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import {
  logProcessResult,
  smokeConfig,
  testTimeoutMs,
  withDedicatedTaggedSandbox,
} from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const maxLifetimeSeconds = 300;
const resources = { cpu: "250m", memory: "256Mi" };
const containers: readonly Container[] = [
  {
    args: ["infinity"],
    command: "sleep",
    image: "python:3.11",
    name: "main",
    primary: true,
    resources,
  },
  {
    args: ["-c", "echo sidecar-ready; exec sleep infinity"],
    command: "sh",
    image: "busybox:1.36",
    name: "sidecar",
    resources,
  },
];

describeWithCredentials("live multi-container smoke", { sequential: true }, () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it(
    "targets each container for exec, files, and logs, and reads the spec back",
    async () => {
      await withDedicatedTaggedSandbox(
        client,
        {
          create: (tag) => client.create({ containers, maxLifetimeSeconds, tags: [tag] }),
        },
        async (sandbox) => {
          console.log(`Started sandbox: ${sandbox.sandboxId}`);

          for (const name of ["main", "sidecar"]) {
            const mark = await sandbox.exec(["sh", "-c", `echo ${name} > /tmp/marker`], {
              container: name,
            });
            expect(mark.exitCode).toBe(0);
          }
          const primary = await sandbox.exec(["cat", "/tmp/marker"]);
          logProcessResult("primary marker", primary);
          expect(primary.stdout.trim()).toBe("main");
          const sidecar = await sandbox.exec(["cat", "/tmp/marker"], { container: "sidecar" });
          logProcessResult("sidecar marker", sidecar);
          expect(sidecar.stdout.trim()).toBe("sidecar");

          await sandbox.files.write("/tmp/sidecar-only.txt", "from sidecar", {
            container: "sidecar",
          });
          await expect(
            sandbox.files.readText("/tmp/sidecar-only.txt", { container: "sidecar" }),
          ).resolves.toBe("from sidecar");
          const absent = await sandbox.exec(["test", "-e", "/tmp/sidecar-only.txt"]);
          expect(absent.exitCode).not.toBe(0);

          const lines = await sandbox.logs.read({ container: "sidecar" });
          expect(lines.some((line) => line.includes("sidecar-ready"))).toBe(true);

          await sandbox.inspect();
          expect(sandbox.containers?.map((row) => [row.name, row.primary === true])).toEqual([
            ["main", true],
            ["sidecar", false],
          ]);
          expect(sandbox.containers?.[1]).toMatchObject({
            args: containers[1]?.args,
            command: "sh",
            image: "busybox:1.36",
          });
        },
      );
    },
    testTimeoutMs,
  );

  it(
    "creates a sandbox from a read-back container spec",
    async () => {
      let readBack: readonly Container[] | undefined;
      await withDedicatedTaggedSandbox(
        client,
        {
          create: (tag) => client.create({ containers, maxLifetimeSeconds, tags: [tag] }),
        },
        (sandbox) => {
          readBack = sandbox.containers;
        },
      );
      expect(readBack).toBeDefined();

      await withDedicatedTaggedSandbox(
        client,
        {
          create: (tag) =>
            client.create({ containers: readBack ?? [], maxLifetimeSeconds, tags: [tag] }),
        },
        async (clone) => {
          console.log(`Started clone: ${clone.sandboxId}`);
          await expect(clone.getStatus()).resolves.toBe("running");
          const sidecar = await clone.exec(["true"], { container: "sidecar" });
          expect(sidecar.exitCode).toBe(0);
        },
      );
    },
    testTimeoutMs,
  );
});
