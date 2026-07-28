// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Parallel batch processing with completion-order progress.
 *
 * JS has no Session / cwsandbox.wait() helper yet — track created sandboxes for
 * cleanup and emulate wait(num_returns=N) with a local Promise.race loop.
 */

import type { Sandbox } from "@coreweave/cwsandbox";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

/**
 * Wait until the next `n` promises settle (completion order), matching Python
 * `cwsandbox.wait(pending, num_returns=n)`.
 */
async function waitForN<T>(
  pending: readonly Promise<T>[],
  n: number,
): Promise<{ done: T[]; pending: Promise<T>[] }> {
  const batchSize = Math.min(n, pending.length);
  const remaining = [...pending];
  const done: T[] = [];

  while (done.length < batchSize) {
    const { promise, value } = await Promise.race(
      remaining.map((promise) => promise.then((value) => ({ promise, value }))),
    );
    done.push(value);
    remaining.splice(remaining.indexOf(promise), 1);
  }

  return { done, pending: remaining };
}

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();
  const taskDurations = [1, 3, 1, 2, 1];
  const totalTasks = taskDurations.length;
  const tag = "example-batch-job";

  console.log(`Starting batch job with ${totalTasks} tasks`);
  console.log(`Task durations: ${taskDurations.join(", ")}\n`);

  // Register each handle as create resolves so a partial failure still cleans up.
  const created: Sandbox[] = [];
  try {
    console.log("Creating sandboxes...");
    const sandboxes = await Promise.all(
      taskDurations.map(async (_, i) => {
        const sandbox = await client.create({ tags: [tag, `task-${i}`] });
        created.push(sandbox);
        return sandbox;
      }),
    );
    console.log(`Created ${sandboxes.length} sandboxes\n`);

    console.log("Submitting tasks...");
    let pending = sandboxes.map((sandbox, i) => {
      const duration = taskDurations[i];
      if (duration === undefined) {
        throw new Error(`Missing duration for task ${i}`);
      }
      return sandbox.commands.run([
        "sh",
        "-c",
        `sleep ${duration} && echo 'Task ${i} done (${duration}s)'`,
      ]);
    });
    console.log(`Submitted ${pending.length} tasks\n`);

    console.log("Waiting for results (processing in batches of 2)...");
    console.log("-".repeat(50));

    let completed = 0;
    while (pending.length > 0) {
      const batchSize = Math.min(2, pending.length);
      const waited = await waitForN(pending, batchSize);
      pending = waited.pending;

      for (const result of waited.done) {
        completed += 1;
        console.log(`[${completed}/${totalTasks}] ${result.stdout.trimEnd()}`);
      }
    }

    console.log("-".repeat(50));
    console.log(`\nBatch job complete: ${completed}/${totalTasks} tasks succeeded`);
  } finally {
    await Promise.all(created.map((sandbox) => sandbox.stop({ missingOk: true })));
    console.log("All sandboxes cleaned up");
  }
}

await main();
