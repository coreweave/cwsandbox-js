// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import {
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxValidationError,
} from "../errors.js";
import { validateRequestOptions } from "../internal/validation/index.js";
import type {
  Command,
  CommandInputData,
  CommandInputWriter,
  CommandProcessStatus,
  TerminalResult,
  TerminalSession,
} from "../public/commands.js";
import type { RequestOptions } from "../public/common.js";
import { AsyncQueue } from "./async-queue.js";

const textEncoder = new TextEncoder();

export type InternalTerminalEvent =
  | { readonly sessionId: string; readonly type: "ready" }
  | { readonly data: Uint8Array; readonly type: "output" }
  | { readonly exitCode: number; readonly type: "exit" }
  | { readonly error: unknown; readonly type: "error" };

export interface TerminalInputController {
  cancel(reason: unknown): Promise<void>;
  close(): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  write(data: Uint8Array): Promise<void>;
}

export interface TerminalSessionController {
  readonly session: TerminalSession;
  dispatch(event: InternalTerminalEvent): Promise<void>;
}

export function createTerminalSession(
  command: Command,
  input: TerminalInputController,
): TerminalSessionController {
  const session = new StreamingTerminalSession(command, input);
  return {
    dispatch: (event) => session.dispatch(event),
    session,
  };
}

class StreamingTerminalSession implements TerminalSession {
  public readonly output: AsyncIterable<Uint8Array>;
  public readonly stdin: CommandInputWriter;

  private readonly outputQueue = new AsyncQueue<Uint8Array>();
  private readonly stdinWriter: TerminalInputWriter;
  private currentExitCode: number | undefined;
  private currentStatus: CommandProcessStatus = "starting";
  private result: TerminalResult | undefined;
  private waitPromise: Promise<TerminalResult>;
  private rejectWait!: (error: unknown) => void;
  private resolveWait!: (result: TerminalResult) => void;
  private settled = false;

  public constructor(
    public readonly command: Command,
    private readonly input: TerminalInputController,
  ) {
    this.output = this.outputQueue;
    this.stdinWriter = new TerminalInputWriter(input, () => this.currentStatus);
    this.stdin = this.stdinWriter;
    this.waitPromise = new Promise<TerminalResult>((resolve, reject) => {
      this.resolveWait = resolve;
      this.rejectWait = reject;
    });
  }

  public async dispatch(event: InternalTerminalEvent): Promise<void> {
    switch (event.type) {
      case "ready":
        this.currentStatus = "running";
        return;
      case "output":
        await this.outputQueue.push(event.data);
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
        };
        this.outputQueue.close();
        this.resolve(this.result);
        return;
      case "error":
        if (this.settled) {
          return;
        }

        this.currentStatus = "failed";
        this.outputQueue.fail(event.error);
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

    const error = new CWSandboxTransportError("Terminal session cancelled.", {
      operation: "Cancel terminal session",
    });
    this.currentStatus = "cancelled";
    this.outputQueue.fail(error);
    this.reject(error);
    await this.stdinWriter.cancel(error);
  }

  public get exitCode(): number | undefined {
    return this.currentExitCode;
  }

  public poll(): number | undefined {
    return this.currentExitCode;
  }

  public async resize(cols: number, rows: number, options: RequestOptions = {}): Promise<void> {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
      validateTerminalDimension(cols, "cols");
      validateTerminalDimension(rows, "rows");
      this.validateActive("resize");
    } catch (error) {
      return Promise.reject(error);
    }

    await this.input.resize(cols, rows);
  }

  public get status(): CommandProcessStatus {
    return this.currentStatus;
  }

  public wait(options: RequestOptions = {}): Promise<TerminalResult> {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }

    return waitWithRequestOptions(this.waitPromise, options);
  }

  private reject(error: unknown): void {
    this.settled = true;
    this.rejectWait(error);
  }

  private resolve(result: TerminalResult): void {
    this.settled = true;
    this.resolveWait(result);
  }

  private validateActive(operation: string): void {
    if (
      this.currentStatus === "cancelled" ||
      this.currentStatus === "exited" ||
      this.currentStatus === "failed"
    ) {
      throw new CWSandboxValidationError(
        `Cannot ${operation} after terminal status '${this.currentStatus}'.`,
      );
    }
  }
}

class TerminalInputWriter implements CommandInputWriter {
  private isClosed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly input: TerminalInputController,
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
      throw new CWSandboxValidationError(`Cannot write stdin after terminal status '${status}'.`);
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

function validateTerminalDimension(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CWSandboxValidationError(`${name} must be a positive integer.`);
  }
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
            new CWSandboxTimeoutError("Timed out waiting for terminal session to complete.", {
              operation: "Wait for terminal session",
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
