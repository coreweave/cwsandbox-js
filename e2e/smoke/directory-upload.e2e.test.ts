// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Container,
  CWSandboxFileError,
  type Sandbox,
  type SandboxClient,
} from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
import { beforeAll, describe, expect, it } from "vitest";

import { smokeConfig, withDedicatedTaggedSandbox } from "./helpers.js";

const describeWithCredentials = smokeConfig.hasCredentials ? describe : describe.skip;
const MiB = 1024 * 1024;
const BIG = 50 * MiB;
const DEST = "/tmp/upload-dest";
const LONG = `${"d".repeat(60)}/${"f".repeat(80)}.txt`;
const uploadTimeoutMs = 10 * 60 * 1000;
const resources = { cpu: "500m", memory: "256Mi" };

class StopAfterFirstPart extends Error {}

async function makeTree(): Promise<{ root: string; sums: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), "cws-upload-e2e-"));
  await mkdir(join(root, "a", "b"), { recursive: true });
  await writeFile(join(root, "a", "b", "deep.txt"), "deep");
  await writeFile(join(root, "a", "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(root, "a", "run.sh"), 0o755);
  await symlink("b/deep.txt", join(root, "a", "link"));
  await mkdir(join(root, "empty"));
  await writeFile(join(root, "café.txt"), "unicode");
  await mkdir(join(root, LONG.split("/")[0] as string));
  await writeFile(join(root, LONG), "long");
  await writeFile(join(root, "skip.log"), "excluded");
  await mkdir(join(root, "cache"));
  await writeFile(join(root, "cache", "x"), "excluded");
  await writeFile(join(root, "big.bin"), randomBytes(BIG));
  const sums: Record<string, string> = {};
  for (const rel of ["a/b/deep.txt", "a/run.sh", "café.txt", LONG, "big.bin"]) {
    sums[rel] = createHash("sha256")
      .update(await readFile(join(root, rel)))
      .digest("hex");
  }
  return { root, sums };
}

async function remoteListing(sandbox: Sandbox): Promise<Record<string, string>> {
  const script =
    `cd ${DEST} && find . -mindepth 1 | sort | while read -r p; do ` +
    'if [ -L "$p" ]; then echo "l $(readlink "$p") $p"; ' +
    'elif [ -d "$p" ]; then echo "d - $p"; ' +
    'else echo "f $(sha256sum < "$p" | cut -d" " -f1) $p"; fi; done; ' +
    "stat -c '%a' a/run.sh";
  const result = await sandbox.exec(["sh", "-c", script], { timeoutMs: 120_000 });
  expect(result.exitCode, result.stderr).toBe(0);
  const lines = result.stdout.trim().split("\n");
  const listing: Record<string, string> = {};
  for (const line of lines.slice(0, -1)) {
    const [kind, value, ...rest] = line.split(" ");
    listing[rest.join(" ").replace(/^\.\//, "")] = `${kind} ${value}`;
  }
  listing["mode:a/run.sh"] = lines.at(-1) ?? "";
  return listing;
}

describeWithCredentials("live directory upload smoke", () => {
  let client: SandboxClient;

  beforeAll(() => {
    client = createSandboxClientFromEnv();
  });

  it.each(["python:3.11", "alpine:3.20"])(
    "uploads a tree with a 50 MB file, interrupted then resumed (%s)",
    async (image) => {
      const { root, sums } = await makeTree();
      const exclude = ["*.log", "cache"];
      await withDedicatedTaggedSandbox(
        client,
        {
          create: (tag) =>
            client.create({
              containerImage: image,
              maxLifetimeSeconds: 600,
              resources,
              tags: [tag],
            }),
          waitUntilRunning: true,
        },
        async (sandbox) => {
          await expect(
            sandbox.files.uploadDirectory(root, DEST, {
              exclude,
              onProgress: () => {
                throw new StopAfterFirstPart();
              },
            }),
          ).rejects.toBeInstanceOf(StopAfterFirstPart);

          const progress: number[][] = [];
          const result = await sandbox.files.uploadDirectory(root, DEST, {
            exclude,
            onProgress: ({ bytesDone, bytesTotal }) => progress.push([bytesDone, bytesTotal]),
          });
          expect(result).toMatchObject({
            directories: 4,
            files: 5,
            resumedBytes: 32 * MiB,
            skipped: [],
            symlinks: 1,
          });
          expect(result.archiveBytes).toBeGreaterThan(BIG);
          expect(progress.at(-1)).toEqual([result.bytes, result.bytes]);

          const listing = await remoteListing(sandbox);
          for (const [rel, digest] of Object.entries(sums)) {
            expect(listing[rel]).toBe(`f ${digest}`);
            delete listing[rel];
          }
          expect(listing).toEqual({
            a: "d -",
            "a/b": "d -",
            "a/link": "l b/deep.txt",
            [LONG.split("/")[0] as string]: "d -",
            empty: "d -",
            "mode:a/run.sh": "755",
          });
        },
      );
    },
    uploadTimeoutMs,
  );

  it("rejects a symlink that points outside the tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "cws-upload-e2e-"));
    await writeFile(join(root, "ok.txt"), "ok");
    await symlink("../../etc/passwd", join(root, "escape"));
    await withDedicatedTaggedSandbox(client, { waitUntilRunning: true }, async (sandbox) => {
      const error = await sandbox.files
        .uploadDirectory(root, DEST)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CWSandboxFileError);
      expect((error as CWSandboxFileError).metadata).toMatchObject({
        path: "escape",
        stage: "archive",
      });
      expect((await sandbox.exec(["test", "-e", DEST])).exitCode).not.toBe(0);
    });
  });

  it("names the missing tools on an image without tar", async () => {
    const root = await mkdtemp(join(tmpdir(), "cws-upload-e2e-"));
    await writeFile(join(root, "a.txt"), "a");
    await withDedicatedTaggedSandbox(
      client,
      {
        create: (tag) =>
          client.create({
            containerImage: "registry.access.redhat.com/ubi9/ubi-micro:latest",
            resources,
            tags: [tag],
          }),
        waitUntilRunning: true,
      },
      async (sandbox) => {
        const error = await sandbox.files
          .uploadDirectory(root, DEST)
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(CWSandboxFileError);
        expect((error as CWSandboxFileError).metadata).toMatchObject({
          missing_tools: "tar gzip",
          stage: "preflight",
        });
      },
    );
  });

  it("uploads into a sidecar container only", async () => {
    const root = await mkdtemp(join(tmpdir(), "cws-upload-e2e-"));
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "x.txt"), "sidecar");
    const containers: readonly Container[] = ["main", "helper"].map((name) => ({
      args: ["infinity"],
      command: "sleep",
      image: "python:3.11",
      name,
      primary: name === "main",
      resources,
    }));
    await withDedicatedTaggedSandbox(
      client,
      {
        create: (tag) => client.create({ containers, maxLifetimeSeconds: 300, tags: [tag] }),
        waitUntilRunning: true,
      },
      async (sandbox) => {
        const result = await sandbox.files.uploadDirectory(root, DEST, { container: "helper" });
        expect(result.files).toBe(1);
        const content = await sandbox.files.readText(`${DEST}/sub/x.txt`, { container: "helper" });
        expect(content).toBe("sidecar");
        expect((await sandbox.exec(["test", "-e", DEST])).exitCode).not.toBe(0);
      },
    );
  });
});
