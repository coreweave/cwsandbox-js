// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

import { CWSandboxTransportError } from "../errors.js";
import { validateRequestOptions } from "../internal/validation/index.js";
import type { RequestOptions } from "../public/common.js";
import type {
  LogEntry,
  LogEntryStream,
  LogRawChunk,
  LogRawStream,
  LogStream,
  LogStreamMode,
} from "../public/logs.js";
import { AsyncQueue } from "./async-queue.js";

const MAX_LINE_BUFFER_BYTES = 64 * 1024;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export interface LogStreamControls {
  cancel(reason: unknown): Promise<void>;
  close(): Promise<void>;
}

interface TimestampLike {
  readonly nanos: number;
  readonly seconds: string;
}

export type LogStreamDataEvent = {
  readonly data: Uint8Array;
  readonly offset?: string;
  readonly sessionId?: string;
  readonly timestamp?: TimestampLike;
};

export type InternalLogEvent =
  | ({ readonly type: "data" } & LogStreamDataEvent)
  | { readonly error: unknown; readonly type: "error" }
  | { readonly type: "complete" };

export interface LogStreamController<TStream extends LogStream | LogEntryStream | LogRawStream> {
  readonly stream: TStream;
  dispatch(event: InternalLogEvent): Promise<void>;
}

export function createLogStream(
  mode: "lines",
  controls: LogStreamControls,
): LogStreamController<LogStream>;
export function createLogStream(
  mode: "entries",
  controls: LogStreamControls,
): LogStreamController<LogEntryStream>;
export function createLogStream(
  mode: "raw",
  controls: LogStreamControls,
): LogStreamController<LogRawStream>;
export function createLogStream(
  mode: LogStreamMode,
  controls: LogStreamControls,
): LogStreamController<LogStream | LogEntryStream | LogRawStream>;
export function createLogStream(
  mode: LogStreamMode,
  controls: LogStreamControls,
): LogStreamController<LogStream | LogEntryStream | LogRawStream> {
  const stream = new StreamingLogStream(mode, controls);
  return {
    stream: stream as LogStream | LogEntryStream | LogRawStream,
    dispatch: (event) => stream.dispatch(event),
  };
}

class StreamingLogStream {
  private readonly queue = new AsyncQueue<string | LogEntry | LogRawChunk>();
  private buffer = "";
  private bufferBytes = 0;
  private bufferMetadata: Omit<LogEntry, "line"> = {};
  private currentOffset: string | undefined;
  private currentSessionId: string | undefined;
  private isClosed = false;

  public constructor(
    private readonly mode: LogStreamMode,
    private readonly controls: LogStreamControls,
  ) {}

  public [Symbol.asyncIterator](): AsyncIterator<string | LogEntry | LogRawChunk> {
    return this.queue[Symbol.asyncIterator]();
  }

  public async cancel(options: RequestOptions = {}): Promise<void> {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    await this.controls.cancel(
      new CWSandboxTransportError("Log stream cancelled.", {
        operation: "Cancel log stream",
      }),
    );
    this.queue.close();
  }

  public async close(options: RequestOptions = {}): Promise<void> {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    await this.controls.close();
    await this.flushRemainder();
    this.queue.close();
  }

  public get closed(): boolean {
    return this.isClosed;
  }

  public get offset(): string | undefined {
    return this.currentOffset;
  }

  public get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  public async dispatch(event: InternalLogEvent): Promise<void> {
    if (this.isClosed && event.type !== "error") {
      return;
    }

    switch (event.type) {
      case "complete":
        this.isClosed = true;
        await this.flushRemainder();
        this.queue.close();
        return;
      case "data":
        await this.handleData(event);
        return;
      case "error":
        this.isClosed = true;
        this.queue.fail(event.error);
        return;
    }
  }

  private async handleData(event: LogStreamDataEvent): Promise<void> {
    this.currentOffset = event.offset;
    this.currentSessionId = event.sessionId;

    if (this.mode === "raw") {
      await this.queue.push({
        data: event.data,
        ...(event.offset === undefined ? {} : { offset: event.offset }),
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        text: textDecoder.decode(event.data),
        ...(event.timestamp === undefined ? {} : { timestamp: timestampToDate(event.timestamp) }),
      });
      return;
    }

    await this.handleLineData(event);
  }

  private async handleLineData(event: LogStreamDataEvent): Promise<void> {
    const text = textDecoder.decode(event.data);
    this.buffer += text;
    this.bufferBytes += event.data.byteLength;
    this.bufferMetadata = metadataFromEvent(event);

    if (!this.buffer.includes("\n") && this.bufferBytes < MAX_LINE_BUFFER_BYTES) {
      return;
    }

    const parts = this.buffer.split("\n");
    const completeParts = parts.slice(0, -1);

    for (const part of completeParts) {
      await this.pushLine(`${part}\n`, this.bufferMetadata);
    }

    const remainder = parts.at(-1) ?? "";
    this.buffer = remainder;
    this.bufferBytes = textEncoder.encode(remainder).byteLength;

    if (this.bufferBytes >= MAX_LINE_BUFFER_BYTES) {
      await this.pushLine(this.buffer, this.bufferMetadata);
      this.buffer = "";
      this.bufferBytes = 0;
    }
  }

  private async flushRemainder(): Promise<void> {
    if (this.buffer === "") {
      return;
    }

    await this.pushLine(this.buffer, this.bufferMetadata);
    this.buffer = "";
    this.bufferBytes = 0;
  }

  private async pushLine(line: string, metadata: Omit<LogEntry, "line">): Promise<void> {
    if (this.mode === "entries") {
      await this.queue.push({
        line,
        ...metadata,
      });
      return;
    }

    await this.queue.push(line);
  }
}

function metadataFromEvent(event: LogStreamDataEvent): Omit<LogEntry, "line"> {
  return {
    ...(event.offset === undefined ? {} : { offset: event.offset }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.timestamp === undefined ? {} : { timestamp: timestampToDate(event.timestamp) }),
  };
}

export function timestampToDate(timestamp: TimestampLike): Date {
  return new Date(Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000));
}
