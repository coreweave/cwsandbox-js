// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Multi-container sandbox: a primary plus a sidecar sharing a scratch volume.
 * Exec, files, and logs target the primary unless `container` names another.
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();
  const resources = { cpu: "250m", memory: "256Mi" };

  const sandbox = await client.create({
    containers: [
      {
        args: ["infinity"],
        command: "sleep",
        image: "python:3.11",
        name: "main",
        primary: true,
        resources,
      },
      {
        args: ["-c", "echo sidecar up; exec sleep infinity"],
        command: "sh",
        image: "busybox:1.36",
        name: "sidecar",
        resources,
        volumeMounts: [{ mountPath: "/shared", volume: "shared" }],
      },
    ],
    // Mounted on the primary at /shared; the sidecar mounts it via volumeMounts.
    volumes: [{ mountPath: "/shared", name: "shared" }],
    maxLifetimeSeconds: 300,
    tags: ["example", "example-multi-container"],
  });

  try {
    console.log(`Sandbox: ${sandbox.sandboxId}`);
    console.log(`Containers: ${sandbox.containers?.map((row) => row.name).join(", ")}`);

    await sandbox.files.write("/shared/hello.txt", "written by the sidecar\n", {
      container: "sidecar",
    });
    const fromPrimary = await sandbox.files.readText("/shared/hello.txt");
    console.log(`Primary reads shared file: ${fromPrimary.trimEnd()}`);

    const busybox = await sandbox.exec(["busybox", "--help"], { container: "sidecar" });
    console.log(`Sidecar: ${busybox.stdout.split("\n")[0]}`);

    const logs = await sandbox.logs.read({ container: "sidecar" });
    console.log(`Sidecar logs: ${logs.join(" | ")}`);
  } finally {
    await sandbox.delete({ missingOk: true });
  }
}

await main();
