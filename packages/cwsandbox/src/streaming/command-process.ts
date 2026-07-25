// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxExecutionError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxValidationError,
} from "../errors.js";
import { validateRequestOptions } from "../internal/validation/index.js";
import type {
  Command,
  CommandInputData,
  CommandInputWriter,
  CommandProcess,
  CommandProcessStatus,
  CommandProcessWithStdin,
  ProcessResult,
} from "../public/commands.js";
import type { RequestOptions } from "../public/common.js";
import { AsyncQueue } from "./async-queue.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const OUTPUT_ACCUMULATION_LIMIT_BYTES = 1024 * 1024;
/** Match Python STREAMING_READ_STDERR_CAP_BYTES for binary file reads. */
const BINARY_STDERR_CAP_BYTES = 16 * 1024;

export type InternalCommandEvent =
  | { readonly sessionId: string; readonly type: "ready" }
  | { readonly data: Uint8Array; readonly type: "stdout" }
  | { readonly data: Uint8Array; readonly type: "stderr" }
  | { readonly exitCode: number; readonly type: "exit" }
  | { readonly error: unknown; readonly type: "error" };

export interface StreamingCommandProcessController<
  TProcess extends CommandProcess = CommandProcess,
> {
  readonly process: TProcess;
  dispatch(event: InternalCommandEvent): Promise<void>;
}

export interface CommandInputController {
  cancel(reason: unknown): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
}

export interface CommandProcessOptions {
  /**
   * When true, accumulate stdout as bytes only: skip UTF-8 decode into the
   * text queue, leave ProcessResult.stdout as "", and push frames to
   * `stdoutBinary`.
   */
  readonly binaryOutput?: boolean;
  readonly bufferedMaxKiB?: number;
  readonly check?: boolean;
  readonly input?: CommandInputController;
  readonly stdin?: boolean;
  /**
   * When true, do not buffer stdout for `wait().stdoutBytes` (consume via
   * `stdoutBinary` instead).
   */
  readonly streamStdoutOnly?: boolean;
}

export function createCommandProcess(
  command: Command,
  options: CommandProcessOptions & { readonly input: CommandInputController; readonly stdin: true },
): StreamingCommandProcessController<CommandProcessWithStdin>;
export function createCommandProcess(
  command: Command,
  options?: CommandProcessOptions,
): StreamingCommandProcessController;
export function createCommandProcess(
  command: Command,
  options: CommandProcessOptions = {},
): StreamingCommandProcessController {
  const process = new StreamingCommandProcess(command, options);
  return {
    process,
    dispatch: (event) => process.dispatch(event),
  };
}

class OutputAccumulator {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private bytesProduced = 0;
  private truncated = false;

  public constructor(private readonly limitBytes = OUTPUT_ACCUMULATION_LIMIT_BYTES) {}

  public append(data: Uint8Array): void {
    this.bytesProduced += data.byteLength;

    if (this.bytes >= this.limitBytes) {
      this.truncated = true;
      return;
    }

    const remaining = this.limitBytes - this.bytes;
    const chunk = data.byteLength > remaining ? data.slice(0, remaining) : data;
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    this.truncated ||= chunk.byteLength < data.byteLength;
  }

  public text(): string {
    return textDecoder.decode(this.bytesValue());
  }

  public bytesValue(): Uint8Array {
    const output = new Uint8Array(this.bytes);
    let offset = 0;

    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return output;
  }

  public produced(): number {
    return this.bytesProduced;
  }

  public isTruncated(): boolean {
    return this.truncated;
  }
}

class StreamingCommandProcess implements CommandProcess {
  public readonly stderr: AsyncIterable<string>;
  public readonly stdin: CommandInputWriter | undefined;
  public readonly stdout: AsyncIterable<string>;
  public readonly stdoutBinary: AsyncIterable<Uint8Array>;

  private readonly stderrQueue = new AsyncQueue<string>();
  private readonly stdoutQueue = new AsyncQueue<string>();
  private readonly stdoutBinaryQueue = new AsyncQueue<Uint8Array>();
  private readonly stderrAccumulator: OutputAccumulator;
  private readonly stdoutAccumulator: OutputAccumulator;
  private readonly binaryOutput: boolean;
  private readonly streamStdoutOnly: boolean;
  private readonly check: boolean;
  private stdoutBytesProduced = 0;
  private result: ProcessResult | undefined;
  private sessionId: string | undefined;
  private currentExitCode: number | undefined;
  private currentStatus: CommandProcessStatus = "starting";
  private readonly input: CommandInputController | undefined;
  private waitPromise: Promise<ProcessResult>;
  private rejectWait!: (error: unknown) => void;
  private resolveWait!: (result: ProcessResult) => void;
  private settled = false;

  public constructor(
    public readonly command: Command,
    options: CommandProcessOptions,
  ) {
    const limitBytes =
      options.bufferedMaxKiB === undefined
        ? OUTPUT_ACCUMULATION_LIMIT_BYTES
        : options.bufferedMaxKiB * 1024;
    this.input = options.input;
    this.binaryOutput = options.binaryOutput === true;
    this.streamStdoutOnly = options.streamStdoutOnly === true;
    this.check = options.check === true;
    this.stdoutAccumulator = new OutputAccumulator(limitBytes);
    this.stderrAccumulator = new OutputAccumulator(
      this.binaryOutput ? BINARY_STDERR_CAP_BYTES : limitBytes,
    );
    this.stdout = this.stdoutQueue;
    this.stderr = this.stderrQueue;
    this.stdoutBinary = this.stdoutBinaryQueue;
    this.stdin =
      options.stdin === true && options.input !== undefined
        ? new StreamingCommandInputWriter(options.input, () => this.currentStatus)
        : undefined;
    this.waitPromise = new Promise<ProcessResult>((resolve, reject) => {
      this.resolveWait = resolve;
      this.rejectWait = reject;
    });
  }

  public async dispatch(event: InternalCommandEvent): Promise<void> {
    switch (event.type) {
      case "ready":
        this.sessionId = event.sessionId;
        this.currentStatus = "running";
        return;
      case "stdout":
        this.stdoutBytesProduced += event.data.byteLength;
        if (!this.streamStdoutOnly) {
          this.stdoutAccumulator.append(event.data);
        }
        if (this.binaryOutput) {
          // Copy so gRPC ownership of the frame cannot alias the caller's buffer.
          this.stdoutBinaryQueue.tryPush(event.data.slice());
        } else {
          this.stdoutQueue.tryPush(textDecoder.decode(event.data));
        }
        return;
      case "stderr":
        this.stderrAccumulator.append(event.data);
        this.stderrQueue.tryPush(textDecoder.decode(event.data));
        return;
      case "exit":
        if (this.settled) {
          return;
        }

        this.currentStatus = "exited";
        this.currentExitCode = event.exitCode;
        this.result = {
          command: this.command,
          exitCode: event.exitCode,
          failed: event.exitCode !== 0,
          ok: event.exitCode === 0,
          stderr: this.stderrAccumulator.text(),
          stderrBytes: this.stderrAccumulator.bytesValue(),
          stderrBytesProduced: this.stderrAccumulator.produced(),
          stderrTruncated: this.stderrAccumulator.isTruncated(),
          stdout: this.binaryOutput ? "" : this.stdoutAccumulator.text(),
          stdoutBytes: this.streamStdoutOnly
            ? new Uint8Array()
            : this.stdoutAccumulator.bytesValue(),
          stdoutBytesProduced: this.streamStdoutOnly
            ? this.stdoutBytesProduced
            : this.stdoutAccumulator.produced(),
          stdoutTruncated: this.streamStdoutOnly ? false : this.stdoutAccumulator.isTruncated(),
        };
        this.stdoutQueue.close();
        this.stdoutBinaryQueue.close();
        this.stderrQueue.close();
        if (this.check && this.result.exitCode !== 0) {
          this.reject(new CWSandboxExecutionError(this.result));
          return;
        }

        this.resolve(this.result);
        return;
      case "error":
        if (this.settled) {
          return;
        }

        this.currentStatus = "failed";
        this.stdoutQueue.fail(event.error);
        this.stdoutBinaryQueue.fail(event.error);
        this.stderrQueue.fail(event.error);
        this.reject(event.error);
        return;
    }
  }

  public async cancel(options: RequestOptions = {}): Promise<void> {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.settled) {
      return;
    }

    const error = new CWSandboxTransportError("Streaming command cancelled.", {
      operation: "Cancel streaming command",
    });
    this.currentStatus = "cancelled";
    this.stdoutQueue.fail(error);
    this.stdoutBinaryQueue.fail(error);
    this.stderrQueue.fail(error);
    this.reject(error);
    await this.cancelInput(error);
  }

  public wait(options: RequestOptions = {}): Promise<ProcessResult> {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }

    return waitWithRequestOptions(this.waitPromise, options);
  }

  public get exitCode(): number | undefined {
    return this.currentExitCode;
  }

  public poll(): number | undefined {
    return this.currentExitCode;
  }

  public get status(): CommandProcessStatus {
    return this.currentStatus;
  }

  private async cancelInput(reason: unknown): Promise<void> {
    if (this.stdin instanceof StreamingCommandInputWriter) {
      await this.stdin.cancel(reason);
      return;
    }

    await this.input?.cancel(reason);
  }

  private reject(error: unknown): void {
    this.settled = true;
    this.rejectWait(error);
  }

  private resolve(result: ProcessResult): void {
    this.settled = true;
    this.resolveWait(result);
  }
}

class StreamingCommandInputWriter implements CommandInputWriter {
  private writeQueue: Promise<void> = Promise.resolve();
  private isClosed = false;

  public constructor(
    private readonly input: CommandInputController,
    private readonly status: () => CommandProcessStatus,
  ) {}

  public get closed(): boolean {
    return this.isClosed;
  }

  public close(options: RequestOptions = {}): Promise<void> {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.isClosed) {
      return Promise.resolve();
    }

    this.isClosed = true;
    this.writeQueue = this.writeQueue.then(() => this.input.close());
    return this.writeQueue;
  }

  public async cancel(reason: unknown): Promise<void> {
    this.isClosed = true;
    await this.input.cancel(reason);
  }

  public write(data: CommandInputData, options: RequestOptions = {}): Promise<void> {
    let bytes: Uint8Array;
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
      this.validateCanWrite();
      bytes = normalizeInputData(data);
    } catch (error) {
      return Promise.reject(error);
    }

    this.writeQueue = this.writeQueue.then(() => this.input.write(bytes));
    return this.writeQueue;
  }

  public writeln(text: string, options: RequestOptions = {}): Promise<void> {
    if (typeof text !== "string") {
      return Promise.reject(new CWSandboxValidationError("stdin.writeln text must be a string."));
    }

    return this.write(`${text}\n`, options);
  }

  private validateCanWrite(): void {
    if (this.isClosed) {
      throw new CWSandboxValidationError("stdin is closed.");
    }

    const status = this.status();
    if (status === "cancelled" || status === "exited" || status === "failed") {
      throw new CWSandboxValidationError(`Cannot write stdin after process status '${status}'.`);
    }
  }
}

function normalizeInputData(data: CommandInputData): Uint8Array {
  if (typeof data === "string") {
    return textEncoder.encode(data);
  }

  if (data instanceof Uint8Array) {
    return data;
  }

  throw new CWSandboxValidationError("stdin.write data must be a string or Uint8Array.");
}

function waitWithRequestOptions<T>(promise: Promise<T>, options: RequestOptions): Promise<T> {
  if (options.timeoutMs === undefined && options.signal === undefined) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => {
      try {
        options.signal?.throwIfAborted();
      } catch (error) {
        settle(() => reject(error));
      }
    };

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        settle(() =>
          reject(
            new CWSandboxTimeoutError("Timed out waiting for streaming command to complete.", {
              operation: "Wait for streaming command",
            }),
          ),
        );
      }, options.timeoutMs);
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });

    void promise.then(
      (value) => {
        settle(() => resolve(value));
      },
      (error: unknown) => {
        settle(() => reject(error));
      },
    );
  });
}
