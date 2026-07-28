<!--
SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
SPDX-License-Identifier: Apache-2.0
SPDX-PackageName: cwsandbox
-->

# CWSandbox JS

TypeScript SDK for CoreWeave Sandbox.

> **Beta (`0.1.0-beta.0`):** public API may still change. Ecosystem adapters
> (TanStack now, Vercel AI planned) version lockstep with this package; the first
> npm cut is core only.

For platform concepts and product guides, see the
[CoreWeave Sandbox documentation](https://docs.coreweave.com/products/coreweave-sandbox/client).

## Install And Prerequisites

This package supports Node.js `>=22` and ESM projects. CI specifically validates
Node.js 22 and 24 (LTS) plus Node.js 26 (Current). The matrix adds each new
Current release, retains active LTS releases, and removes versions at Node EOL.

```bash
npm install @coreweave/cwsandbox@beta
```

Other package managers:

```bash
pnpm add @coreweave/cwsandbox@beta
yarn add @coreweave/cwsandbox@beta
```

Use an API key with the Node gRPC client:

```bash
export CWSANDBOX_API_KEY="..."
export CWSANDBOX_BASE_URL="https://api.cwsandbox.com" # Optional.
```

`CWSANDBOX_BASE_URL` defaults to `https://api.cwsandbox.com`. If `CWSANDBOX_API_KEY`
is missing or blank, `createSandboxClientFromEnv()` throws `CWSandboxConfigurationError`.

To authenticate through the W&B sandbox gateway, use the W&B wrapper subpath:

```bash
export WANDB_API_KEY="..."
export WANDB_ENTITY="my-team"      # Optional.
export WANDB_PROJECT="sandbox"     # Optional.
export WANDB_SANDBOX_BASE_URL="..." # Optional gateway override.
```

```ts
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/wandb";

const client = createSandboxClientFromEnv();
```

W&B auth resolves credentials in order: explicit `apiKey`, `WANDB_API_KEY`, then
the password for `api.wandb.ai` or `wandb.ai` in `~/.netrc`. The W&B wrapper sends
`x-wandb-api-key`, `x-cwsandbox-client-version`, `x-wandb-sdk-version`, optional
entity/project headers, and `x-sandbox-integration: js-sdk` to the sandbox gateway.
Both version headers use this package's version for now.

## Entrypoints

The root package is transport-neutral and contains public types, errors, and the injectable client:

```ts
import { DEFAULT_KEEP_ALIVE_COMMAND } from "@coreweave/cwsandbox";
import { SandboxClient } from "@coreweave/cwsandbox";
import type { SandboxTransport } from "@coreweave/cwsandbox";
```

Node gRPC helpers live under the Node entrypoint:

```ts
import { DEFAULT_CONTAINER_IMAGE } from "@coreweave/cwsandbox/node";
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";
```

`createSandboxClientFromEnv()` reads `CWSANDBOX_API_KEY` and optional `CWSANDBOX_BASE_URL`.
`DEFAULT_KEEP_ALIVE_COMMAND` keeps a sandbox available for multiple operations and exits cleanly when stopped; `client.create()` uses it by default.
When `containerImage` is omitted, the Node transport uses `DEFAULT_CONTAINER_IMAGE` (`python:3.11`).

The W&B wrapper subpath exposes W&B-native factory names:

```ts
import { createSandboxClient } from "@coreweave/cwsandbox/wandb";

const client = createSandboxClient({
  apiKey: "...",
  entity: "my-team",
  project: "sandbox",
});
```

This subpath is intentionally a lightweight proof point for W&B gateway auth. A
future W&B SDK wrapper can resolve logged-in W&B credentials automatically and add
W&B Serverless policy guardrails. For now, avoid runner/profile placement
overrides, GPU resource requests, and unsupported egress modes when using the W&B
gateway path.

## Adapter Packages

Additional ecosystem adapters are sibling workspace packages in this monorepo so
they can carry their own peer dependencies and compatibility tests.

- `@coreweave/cwsandbox-tanstack` adapts this SDK to TanStack AI's
  `SandboxProvider` contract for `defineSandbox(...)` / `withSandbox(...)`
  workflows (same lockstep version; private until its fast-follow publish).

## Examples

Runnable starter examples live under `examples/`.

- `examples/tanstack` runs a deterministic command through the experimental TanStack AI sandbox adapter.
- `examples/weave` traces a minimal CoreWeave Sandbox hello-world command with the Weave TypeScript SDK.

Run the TanStack example with:

```bash
pnpm --dir examples/tanstack start
```

Typecheck it without creating a live sandbox:

```bash
pnpm example:tanstack:typecheck
```

Run the Weave example with:

```bash
pnpm --dir examples/weave start
```

Typecheck it without creating a live sandbox:

```bash
pnpm example:weave:typecheck
```

## API Map

- `SandboxClient` creates, reconnects, lists, and deletes sandboxes through an injected transport.
- `createSandboxClientFromEnv()` in `@coreweave/cwsandbox/node` wires the Node gRPC transport from environment variables.
- `client.withSandbox(callback, options)` runs short-lived work in a ready sandbox with automatic cleanup.
- `client.create(options)` starts a long-lived ready sandbox you manage explicitly.
- `client.run(command, options)` starts a sandbox with a custom main process.
- `sandbox.commands.run(...)` buffers command output.
- `sandbox.commands.start(...)` streams command output and optionally accepts stdin.
- `sandbox.files.*` reads and writes sandbox files (`readStream` / `writeStream` for incremental transfers).
- `sandbox.logs.*` reads or streams the sandbox main process logs.
- `sandbox.wait(...)`, `sandbox.stop(...)`, and `sandbox.delete(...)` manage lifecycle.
  `stop()` requests shutdown and waits until the sandbox is terminal; use
  `wait({ targetStatus: "terminal" })` to observe completion without sending Stop.

## Quickstart

Prefer `withSandbox()` for short-lived work. It starts a sandbox, passes it to your callback, and stops it when the callback finishes.

```ts
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

const client = createSandboxClientFromEnv();

const result = await client.withSandbox(async (sandbox) => {
  return sandbox.commands.run(["python", "-c", "print('hello from cwsandbox-js')"]);
});

console.log(result.stdout);
```

Use `create()` directly when you need to keep a sandbox across multiple operations:

```ts
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

const client = createSandboxClientFromEnv();
const sandbox = await client.create();

try {
  const result = await sandbox.commands.run(["python", "-c", "print('hello')"]);
  console.log(result.stdout);
} finally {
  // Resolves after Stop RPC and the sandbox reaches completed/failed/terminated.
  await sandbox.stop();
}
```

`await sandbox.stop()` is Stop-then-wait: it sends the Stop RPC (unless the sandbox is
already `terminating` or terminal), then polls until a terminal status. Concurrent or
repeated `stop()` calls on the same handle share one in-flight operation. Per-call
`signal` / `timeoutMs` only bound that waiter’s await; they do not cancel shared shutdown
work for other waiters, and aborting does not undo a Stop that already succeeded.

After a successful Stop, a brief `NotFound` race is retried (~2s). If terminal status is
still unobservable, `stop()` throws `CWSandboxTerminalStateUnavailableError`.

To watch an already-stopping sandbox without sending Stop:

```ts
await sandbox.wait({ targetStatus: "terminal", timeoutMs: 60_000 });
console.log(sandbox.status); // completed | failed | terminated
```

`wait()` still defaults to a 60s timeout (including `targetStatus: "terminal"`).
`stop()`’s shared wait is unbounded unless a waiter passes `timeoutMs`.

Status polling uses an internal backoff (about 200ms toward 2s). Transient Get
failures (`unavailable`, request deadline, `resource_exhausted`) are retried within
an internal ~30s budget; the wait’s absolute `timeoutMs` deadline also clamps that
burst so retries cannot overrun the waiter. `NOT_FOUND` is not retried on
observe-only waits. When the server includes AIP-193 `RetryInfo`, the SDK honors
`retryDelayMs` (capped at 10s). Poll pacing and retry budget are not public
options — bound waits with `timeoutMs` / `signal` / `targetStatus` (the former
fixed `intervalMs` wait option is removed in beta; Python has no wait poll-interval
knob either).

Modern runtimes can also use explicit resource management:

```ts
import { createSandboxClientFromEnv } from "@coreweave/cwsandbox/node";

const client = createSandboxClientFromEnv();
await using sandbox = await client.create();
const result = await sandbox.commands.run(["python", "-c", "print('hello')"]);
console.log(result.stdout);
```

`client.create()`, `client.run(...)`, and `client.withSandbox(...)` wait for the sandbox to reach
`running` by default, so the returned sandbox is safe for exec, file, and log operations. This is
sandbox lifecycle readiness, not application readiness: if your main process starts an HTTP server
or performs setup, wait for that app-specific condition with commands, logs, files, or ports.

Pass `waitUntilRunning: false` when you need a handle immediately after the backend accepts the
start request:

```ts
const sandbox = await client.create({ waitUntilRunning: false });
await sandbox.wait({ timeoutMs: 30_000 });
```

Use `run()` when the sandbox main process matters, for example to stream logs from PID 1:

```ts
const sandbox = await client.run(["python", "-m", "http.server", "8000"], {
  ports: [8000],
});
```

## Commands

`sandbox.commands.run()` executes a command and returns buffered stdout/stderr plus an exit code.
`sandbox.exec()` is a direct alias.

```ts
const result = await sandbox.commands.run(["python", "-c", "print('ok')"]);

if (result.exitCode !== 0) {
  console.error(result.stderr);
}
```

Use `cwd` for a working directory and `bufferedMaxKiB` to request a buffered output cap:

```ts
await sandbox.commands.run(["pwd"], { cwd: "/tmp" });

await sandbox.commands.run(["python", "-c", "print('hello')"], {
  bufferedMaxKiB: 64,
});
```

Use `commands.start()` when you need to stream output while a command is running:

```ts
const process = await sandbox.commands.start(["pytest", "-q"], {
  cwd: "/workspace",
});

for await (const chunk of process.stdout) {
  console.log(chunk);
}

const result = await process.wait();
console.log(process.status);
console.log(result.exitCode);
console.log(result.ok);
```

`commands.start()` is text-oriented (`stdout` / `stderr` are string streams). For
binary file transfers, use `files.readStream` / `files.writeStream` instead of
command stdout.

`process.poll()` returns `undefined` while the command is still running, then the exit code after completion. `process.exitCode` is also populated after the command exits.
`process.wait({ timeoutMs, signal })` can bound how long you wait locally without changing the running command.

Enable `stdin` when the command needs input. With `{ stdin: true }`, TypeScript returns a process with a non-optional `stdin` writer:

```ts
const process = await sandbox.commands.start(["cat"], {
  stdin: true,
});

await process.stdin.writeln("hello");
await process.stdin.close(); // Sends EOF to the process.

const result = await process.wait();
console.log(result.stdout);
```

### Interactive Shell

Use `sandbox.shell()` for TTY sessions that need terminal semantics such as ANSI
escape sequences, shell prompts, and resize events. TTY output is raw bytes with
stdout and stderr merged, so decode it only when you want text:

```ts
const terminal = await sandbox.shell({
  command: ["/bin/sh"],
  cols: 80,
  rows: 24,
});

const output = (async () => {
  for await (const chunk of terminal.output) {
    process.stdout.write(chunk);
  }
})();

await terminal.stdin.writeln("echo hello from tty");
await terminal.resize(120, 40);
await terminal.stdin.writeln("exit 0");
await terminal.stdin.close();

const result = await terminal.wait();
await output;
console.log(result.exitCode);
```

The default shell command is `["/bin/bash"]`. Command resume is not part of the
initial shell API.

`wait()` returns accumulated output plus convenience result helpers:

```ts
const result = await sandbox.commands.run(["python", "-c", "import sys; sys.exit(1)"]);

if (result.failed) {
  console.error(result.stderr);
}
```

Use `check: true` when non-zero process exits should throw `CWSandboxExecutionError`.
The error includes the full `ProcessResult`:

```ts
import { CWSandboxExecutionError } from "@coreweave/cwsandbox";

try {
  await sandbox.commands.run(["pytest", "-q"], { check: true });
} catch (error) {
  if (error instanceof CWSandboxExecutionError && error.result !== undefined) {
    console.error(error.result.exitCode);
    console.error(error.result.stderr);
  } else {
    throw error;
  }
}
```

Use `bufferedMaxKiB` with `commands.start()` to cap the final accumulated `stdout` / `stderr` stored on the result. Live streamed chunks are still delivered as they arrive:

```ts
const process = await sandbox.commands.start(["pytest", "-q"], {
  bufferedMaxKiB: 1024,
});
```

`ProcessResult` also includes `stdoutBytes`, `stderrBytes`, numeric `stdoutBytesProduced` / `stderrBytesProduced`, and truncation booleans. Streaming chunks are text chunks, not guaranteed lines. `stdout` and `stderr` are single-consumer async iterables; consume them while the command runs if you need every live chunk. `wait()` remains reliable even when streams are not consumed. Non-zero process exits resolve through `wait()` with an exit code by default, or throw `CWSandboxExecutionError` when the command was started with `check: true`; transport failures always throw SDK errors.

`process.cancel()` cancels the client-side streaming call. It is not named `kill()` because the current streaming protocol does not expose a remote process signal contract. TTY and command resume are future features.

## Logs

The logs namespace streams stdout/stderr from the sandbox main command passed to `client.run()`. Output from `commands.run()` and `commands.start()` is not included in sandbox logs.

```ts
const lines = await sandbox.logs.read({ tailLines: 100 });
console.log(lines.join(""));
```

Follow logs like `tail -f` and close the stream when you are done:

```ts
const logs = await sandbox.logs.stream({ follow: true, tailLines: 10 });

try {
  for await (const line of logs) {
    process.stdout.write(line);
    if (line.includes("READY")) {
      await logs.close();
    }
  }
} finally {
  await logs.close();
}
```

Use `sinceTime` and `timestamps` for bounded reads:

```ts
const recent = await sandbox.logs.read({
  sinceTime: new Date(Date.now() - 60_000),
  timestamps: true,
});
```

Advanced log APIs expose cursor metadata and raw backend chunks:

```ts
for await (const entry of await sandbox.logs.streamEntries({ follow: true })) {
  console.log(entry.offset, entry.line);
}

for await (const chunk of await sandbox.logs.streamRaw({ tailLines: 1 })) {
  console.log(chunk.data.byteLength, chunk.text);
}
```

Resume is explicit and caller-controlled:

```ts
const resumed = await sandbox.logs.stream({
  follow: true,
  resume: { offset: "128", sessionId: "session-123" },
});

await resumed.cancel();
```

The default keep-alive command is silent. Log streams are line-oriented; `streamRaw()` is available when you need exact backend chunk boundaries.

## Files

The files namespace supports string and `Uint8Array` content.

```ts
await sandbox.files.write("/tmp/hello.txt", "hello");

const text = await sandbox.files.readText("/tmp/hello.txt");
const bytes = await sandbox.files.read("/tmp/hello.txt");
```

### Buffered vs streaming

| API                                      | Shape                                | Best for                                                |
| ---------------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| `files.read` / `files.write`             | Fully buffered `Uint8Array` / string | Small–medium files                                      |
| Auto StreamExec fallback (#9)            | Still buffered end-to-end            | Mid-size unary overflow up to ~256 MiB                  |
| `files.readStream` / `files.writeStream` | Incremental `Uint8Array` chunks      | Large files; escape hatch past the 256 MiB buffered cap |

Payloads up to roughly 32 MiB use unary file RPCs. Larger payloads (up to
256 MiB) automatically fall back to a single StreamExec (`sh` + `cat`) path,
matching the Python SDK. Writes above 256 MiB (and oversized reads that are not
auto-fallback candidates) are refused on the buffered APIs with
`CWSandboxFileError` and reason `CWSANDBOX_FILE_TOO_LARGE` — use
`writeStream` / `readStream` instead. The buffered StreamExec auto-fallback can
still OOM (exit 137) on larger mid-size payloads today — the same environmental
limit as Python; incremental streaming avoids accumulating the full payload in
the SDK.

```ts
// Incremental write: bare buffer is sliced into 64 KiB chunks, or pass an iterable.
await sandbox.files.writeStream("/tmp/big.bin", new Uint8Array(1024));

await sandbox.files.writeStream("/tmp/chunks.bin", [
  new Uint8Array([1, 2]),
  new Uint8Array([3, 4]),
]);

// Incremental read: drain promptly into a fast local sink (avoid slow work here).
let total = 0;
for await (const chunk of sandbox.files.readStream("/tmp/big.bin")) {
  total += chunk.byteLength;
}
console.log(total);
```

Notes for streaming:

- Mid-failure or `signal` abort on `writeStream` may leave a **partial remote file**.
- Early stop / abort on `readStream` best-effort cancels the StreamExec process.
- Slow work inside the read loop can trip `CWSandboxStreamBackpressureError`
  (`STREAM_BACKPRESSURE`); drain first, process afterward.
- Bad iterable chunks (not `Uint8Array`) throw `CWSandboxValidationError`.

The buffered methods also accept batch inputs:

```ts
await sandbox.files.write({
  "/tmp/a.txt": "hello",
  "/tmp/b.bin": new Uint8Array([1, 2, 3]),
});

const texts = await sandbox.files.readText(["/tmp/a.txt"]);
const files = await sandbox.files.read(["/tmp/b.bin"]);

console.log(texts["/tmp/a.txt"]);
console.log(files["/tmp/b.bin"]);
```

## Start Options

### Mounted Files

Use record form for concise text or byte mounts:

```ts
const sandbox = await client.run(["python", "/workspace/main.py"], {
  mountedFiles: {
    "/workspace/main.py": "print('hello from mounted file')",
  },
});
```

Use array form when you prefer explicit objects:

```ts
await client.run(["python", "/workspace/main.py"], {
  mountedFiles: [
    {
      path: "/workspace/main.py",
      content: "print('hello')",
    },
  ],
});
```

### Resources

Flat CPU/memory resources map to guaranteed requests:

```ts
await client.run(["python"], {
  resources: {
    cpu: "2",
    memory: "4Gi",
  },
});
```

Use requests/limits for burstable CPU and memory:

```ts
await client.run(["python"], {
  resources: {
    requests: { cpu: "1", memory: "1Gi" },
    limits: { cpu: "4", memory: "8Gi" },
  },
});
```

### Tags

Tags are useful for discovery and cleanup:

```ts
const tags = ["project-demo", "purpose-smoke"] as const;

const sandbox = await client.create({ tags });
const listed = await client.list({ tags: ["project-demo"] });
```

Tags may contain letters, numbers, `.`, `_`, or `-`, must be 59 characters or fewer, and must end with a letter or number.

### Annotations

Annotations are non-sensitive infrastructure metadata for the sandbox pod:

```ts
await client.run(["python"], {
  annotations: {
    team: "platform",
    purpose: "smoke-test",
  },
});
```

Do not put secrets in annotations. Use `secrets` for store-backed injection.

### Secrets

Pass secret-store references at create/run time. The gateway resolves them
server-side and injects the values as environment variables. The client never
sends secret values.

Field names match the Python SDK `Secret` (`store`, `name`, `field`, `env_var`),
with camelCase `envVar` for TypeScript. On the wire, `name` is sent as proto
`SecretMapping.path`. At most 50 secrets may be referenced per sandbox (Gateway
pre-resolve limit).

```ts
await client.create({
  secrets: [
    { store: "wandb-team-secrets", name: "HF_TOKEN" },
    {
      store: "wandb-team-secrets",
      name: "db-credentials",
      field: "password",
      envVar: "DB_PASS",
    },
  ],
});
```

- `store` must match a Gateway-registered secret store name for the organization.
  For W&B team secrets this is typically `wandb-team-secrets`.
- `name` is the secret id in that store (proto `path`).
- `field` is optional for structured secrets.
- `envVar` defaults to `name` when omitted.

For W&B-backed stores, authenticate through the W&B client path
(`@coreweave/cwsandbox/wandb`) so identity claims can resolve team secrets.
Create the secret in the W&B team Secret Manager first; registering the org
secret store on Gateway is a one-time admin step.

Do not put secret values in `environmentVariables`, annotations, or tags.

### Network And Ports

Request egress behavior with `network.egressMode`:

```ts
await client.run(["python"], {
  network: {
    egressMode: "internet",
  },
});

await client.run(["python"], {
  network: {
    egressMode: "none",
  },
});
```

Declare ports with a numeric shorthand or object form:

```ts
await client.run(["python", "-m", "http.server", "8000"], {
  ports: [8000],
});

await client.run(["python", "-m", "http.server", "8000"], {
  ports: [{ port: 8000, name: "http", protocol: "TCP" }],
  network: {
    ingressMode: "public",
    exposedPorts: [8000],
    egressMode: "internet",
  },
});
```

Network mode names, profile names, runner IDs, and ingress modes are backend/profile specific.

Sandbox handles expose cached backend metadata. Use `inspect()` when you need a
fresh one-shot metadata snapshot for traces, tool results, or logs:

```ts
const sandbox = await client.run(["python", "-m", "http.server", "8000"], {
  ports: [{ port: 8000, name: "http", protocol: "TCP" }],
  network: {
    ingressMode: "public",
    exposedPorts: [8000],
    egressMode: "internet",
  },
});

const info = await sandbox.inspect();

const sandboxTrace = {
  sandboxId: info.sandboxId,
  status: info.status,
  startedAt: info.startedAt?.toISOString(),
  serviceAddress: info.serviceAddress,
  exposedPorts: info.exposedPorts,
  appliedIngressMode: info.appliedIngressMode,
  appliedEgressMode: info.appliedEgressMode,
  runnerId: info.runnerId,
  profileId: info.profileId,
  statusReason: info.statusReason,
};

console.log(sandboxTrace);
```

### Placement Selectors

Use profile and runner selectors when you need specific infrastructure:

```ts
await client.run(["python"], {
  profileNames: ["default"],
  runnerIds: ["runner-1"],
});
```

## Reconnect, List, And Delete

Get fresh sandbox metadata without creating a sandbox handle:

```ts
const info = await client.get("sandbox-id");
console.log(info.status);
```

Reconnect to an existing sandbox:

```ts
const sandbox = await client.fromId("sandbox-id");
```

Use `fromId()` when you need to run commands, read files, stream logs, or manage lifecycle through a `Sandbox` instance. Use `get()` when you only need current metadata.

List sandboxes — most callers want every match as usable handles:

```ts
const sandboxes = await client.listAll({
  tags: ["project-demo"],
  pageSize: 25,
});

await Promise.all(sandboxes.map((sandbox) => sandbox.delete()));
```

`listAll()` is an alias of `listSandboxes(...).collect()`. Both return `Sandbox` instances built from list metadata (no extra RPCs until you call methods on a handle). `list()` returns one page of `SandboxInfo` metadata plus an optional `nextPageToken` if you are managing pagination yourself. On the helpers, `timeoutMs` is a wall-clock budget across all pages (default 300 seconds), not a per-page RPC timeout.

Stream sandboxes as pages arrive:

```ts
for await (const sandbox of client.listSandboxes({ tags: ["project-demo"], pageSize: 25 })) {
  await sandbox.delete();
}
```

Process page batches:

```ts
for await (const page of client.listSandboxes({ tags: ["project-demo"], pageSize: 25 }).byPage()) {
  await Promise.all(page.map((sandbox) => sandbox.delete()));
}
```

One page at a time (manual pagination):

```ts
const { sandboxes, nextPageToken } = await client.list({
  tags: ["project-demo"],
  pageSize: 25,
});
```

Delete through the client or sandbox instance:

```ts
await client.delete("sandbox-id");
await sandbox.delete();
```

By default, deleting a missing sandbox raises `CWSandboxNotFoundError`. Pass
`missingOk: true` for cleanup scripts that should treat “already gone” as
success (same for `stop({ missingOk: true })`):

```ts
await client.delete("sandbox-id", { missingOk: true });
await sandbox.stop({ missingOk: true });
```

Clean up interrupted work by listing with the same tags you used at start:

```ts
const sandboxes = await client.listAll({
  tags: ["project-demo"],
});

await Promise.all(sandboxes.map((sandbox) => sandbox.delete({ missingOk: true })));
```

## Error Handling

All SDK errors extend `CWSandboxError` and expose a stable `code` string.
Transport failures may also carry AIP-193 fields when the backend includes
`google.rpc.ErrorInfo` / `RetryInfo` in gRPC status details:

- `reason` — branch key (e.g. `CWSANDBOX_SANDBOX_NOT_FOUND`)
- `domain` — namespace; reason→class mapping only applies for `cwsandbox.com`
- `metadata` — ErrorInfo metadata map (always an object; empty when absent)
- `retryDelayMs` — optional RetryInfo hint

```ts
import { CWSANDBOX_FILE_TOO_LARGE } from "@coreweave/cwsandbox";
import { CWSandboxNotFoundError } from "@coreweave/cwsandbox";
import { CWSandboxStreamBackpressureError } from "@coreweave/cwsandbox";
import { CWSandboxTimeoutError } from "@coreweave/cwsandbox";
import { CWSandboxTransportError } from "@coreweave/cwsandbox";
import { CWSandboxUnavailableError } from "@coreweave/cwsandbox";
import { CWSandboxValidationError } from "@coreweave/cwsandbox";
import { isCWSandboxError } from "@coreweave/cwsandbox";

try {
  await sandbox.wait({ timeoutMs: 10_000 });
} catch (error) {
  if (error instanceof CWSandboxTimeoutError) {
    console.error("Sandbox did not become ready in time.");
  } else if (error instanceof CWSandboxUnavailableError) {
    console.error("Sandbox service is temporarily unavailable.");
  } else if (error instanceof CWSandboxNotFoundError) {
    console.error("Sandbox no longer exists.");
  } else if (error instanceof CWSandboxStreamBackpressureError) {
    console.error("Drain streams faster or use files.readStream / writeStream.");
  } else if (
    error instanceof CWSandboxTransportError &&
    error.reason === CWSANDBOX_FILE_TOO_LARGE
  ) {
    console.error("File too large for unary path; use streaming.");
  } else if (error instanceof CWSandboxValidationError) {
    console.error(error.message);
  } else if (isCWSandboxError(error)) {
    console.error(error.code, error.message);
  } else {
    throw error;
  }
}
```

Transport errors may also include `operation`, `sandboxId`, `transport`, and
`transportCode` for logging. Raw gRPC trailing metadata stays on `error.cause`
when the failure came from the Node gRPC transport.

## Testing Without Credentials

You can unit test application code by injecting a fake `SandboxTransport`:

```ts
import { SandboxClient, type Command, type SandboxTransport } from "@coreweave/cwsandbox";

const resultFor = (command: Command) => ({
  command,
  exitCode: 0,
  failed: false,
  ok: true,
  stderr: "",
  stderrBytes: new Uint8Array(),
  stderrBytesProduced: 0,
  stderrTruncated: false,
  stdout: "ok\n",
  stdoutBytes: new TextEncoder().encode("ok\n"),
  stdoutBytesProduced: 3,
  stdoutTruncated: false,
});

const transport: SandboxTransport = {
  async start(request) {
    return { sandboxId: `test-${request.command[0]}`, status: "running" };
  },
  async get(request) {
    return { sandboxId: request.sandboxId, status: "running" };
  },
  async list() {
    return { sandboxes: [] };
  },
  async delete() {},
  async stop() {},
  async exec(request) {
    return resultFor(request.command);
  },
  async startCommand() {
    throw new Error("Streaming is not used in this test.");
  },
  async startShell() {
    throw new Error("Shell sessions are not used in this test.");
  },
  async streamLogs() {
    throw new Error("Logs are not used in this test.");
  },
  async writeFile() {},
  async readFile() {
    return { content: new Uint8Array() };
  },
};

const client = new SandboxClient({ transport });
```

The fake transport only needs to implement the operations your application calls. For a fuller
contract reference, see `src/transport.contract.test.ts`.

## Environment

Copy `.env.example` for local experiments:

```bash
CWSANDBOX_API_KEY=
CWSANDBOX_BASE_URL=https://api.cwsandbox.com
WANDB_API_KEY=
WANDB_ENTITY=
WANDB_PROJECT=
WANDB_SANDBOX_BASE_URL=
```

Do not put secret values in `environmentVariables`, `annotations`, or tags.
Use `secrets` for store-backed injection (see [Secrets](#secrets)).

## Development

This package lives in a pnpm monorepo. From the repository root:

```bash
pnpm install
pnpm check
```

Useful root commands:

- `pnpm test` runs core unit tests.
- `pnpm test:types` runs public API type tests.
- `pnpm test:readme` typechecks TypeScript examples in this README.
- `pnpm test:package` builds the package and checks real package exports from fixture consumers.
- `pnpm format:fix` applies Oxfmt formatting.
- `pnpm lint:fix` applies Oxlint fixes.
- `pnpm fix` runs lint fixes and formatting.
- `pnpm smoke` runs the credential-gated live e2e smoke suite, including W&B auth when `WANDB_API_KEY` or a W&B `.netrc` entry is available.
- `pnpm smoke:stress` runs the credential-gated standard stress smoke suite.
- `pnpm smoke:stress -- --heavy` runs the larger manual stress smoke suite.
- `pnpm smoke:stress -- --cleanup --tag <stress-tag>` deletes sandboxes from an interrupted stress run.

`pnpm check` is offline and credential-free, including README example typechecks. `pnpm smoke` and stress smoke commands skip CoreWeave-auth tests when `CWSANDBOX_API_KEY` is not set, and skip W&B-auth tests when no `WANDB_API_KEY` or W&B `.netrc` credential resolves. The default smoke suite uses `internet` and `none` egress modes for network checks. Stress smoke is intentionally not part of `pnpm check`; it creates live sandboxes and uses bounded workloads to exercise larger logs, streams, stdin, files, pagination, and cleanup paths.

## License

This package is licensed under the Apache-2.0 license. See
[`LICENSE-Apache-2.0.txt`](./LICENSE-Apache-2.0.txt) and [`NOTICE`](./NOTICE).

Repository examples under `examples/` are licensed under the BSD-3-Clause license.
