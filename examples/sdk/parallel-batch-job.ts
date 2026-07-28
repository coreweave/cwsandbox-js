// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-PackageName: cwsandbox

/**
 * Parallel batch processing with Promise.allSettled progress.
 *
 * JS has no Session / cwsandbox.wait() helper yet — use the client + Promise.
 */

import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

async function main(): Promise<void> {
  const client = createSandboxClientFromEnv();
  const taskDurations = [1, 3, 1, 2, 1];
  const totalTasks = taskDurations.length;
  const tag = "example-batch-job";

  console.log(`Starting batch job with ${totalTasks} tasks`);
  console.log(`Task durations: ${taskDurations.join(", ")}\n`);

  console.log("Creating sandboxes...");
  const sandboxes = await Promise.all(
    taskDurations.map((_, i) => client.create({ tags: [tag, `task-${i}`] })),
  );
  console.log(`Created ${sandboxes.length} sandboxes\n`);

  try {
    console.log("Submitting tasks...");
    const tasks = sandboxes.map((sandbox, i) => {
      const duration = taskDurations[i];
      if (duration === undefined) {
        throw new Error(`Missing duration for task ${i}`);
      }
      return sandbox.commands
        .run(["sh", "-c", `sleep ${duration} && echo 'Task ${i} done (${duration}s)'`])
        .then((result) => ({ index: i, result }));
    });

    let completed = 0;
    const settled = await Promise.allSettled(tasks);
    console.log("-".repeat(50));
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        completed += 1;
        console.log(`[${completed}/${totalTasks}] ${outcome.value.result.stdout.trimEnd()}`);
      } else {
        console.error(`Task failed: ${String(outcome.reason)}`);
      }
    }
    console.log("-".repeat(50));
    console.log(`\nBatch job complete: ${completed}/${totalTasks} tasks succeeded`);
  } finally {
    await Promise.all(sandboxes.map((sandbox) => sandbox.stop({ missingOk: true })));
    console.log("All sandboxes cleaned up");
  }
}

await main();
