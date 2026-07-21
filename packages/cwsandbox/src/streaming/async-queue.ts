// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: cwsandbox

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waitingConsumers: Array<{
    readonly reject: (error: unknown) => void;
    readonly resolve: (value: IteratorResult<T>) => void;
  }> = [];
  private readonly waitingProducers: Array<() => void> = [];
  private closed = false;
  private consumed = false;
  private error: unknown;

  public constructor(private readonly capacity = 64) {}

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) {
      throw new Error("Stream already has a consumer.");
    }

    this.consumed = true;
    return {
      next: () => this.next(),
    };
  }

  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.drainConsumers();
    this.releaseProducers();
  }

  public fail(error: unknown): void {
    if (this.closed) {
      return;
    }

    this.error = error;
    this.closed = true;
    this.drainConsumers();
    this.releaseProducers();
  }

  public async push(item: T): Promise<void> {
    if (this.closed) {
      return;
    }

    while (this.items.length >= this.capacity && !this.closed) {
      await new Promise<void>((resolve) => {
        this.waitingProducers.push(resolve);
      });
    }

    if (this.closed) {
      return;
    }

    const consumer = this.waitingConsumers.shift();
    if (consumer !== undefined) {
      consumer.resolve({ done: false, value: item });
      return;
    }

    this.items.push(item);
  }

  public tryPush(item: T): boolean {
    if (this.closed) {
      return false;
    }

    const consumer = this.waitingConsumers.shift();
    if (consumer !== undefined) {
      consumer.resolve({ done: false, value: item });
      return true;
    }

    if (this.items.length >= this.capacity) {
      return false;
    }

    this.items.push(item);
    return true;
  }

  private drainConsumers(): void {
    while (this.waitingConsumers.length > 0) {
      const consumer = this.waitingConsumers.shift();
      if (consumer === undefined) {
        return;
      }

      if (this.error === undefined) {
        consumer.resolve({ done: true, value: undefined });
      } else {
        consumer.reject(this.error);
      }
    }
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      const value = this.items.shift();
      this.releaseProducer();
      if (value !== undefined) {
        return Promise.resolve({ done: false, value });
      }
    }

    if (this.error !== undefined) {
      return Promise.reject(this.error);
    }

    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waitingConsumers.push({ reject, resolve });
    });
  }

  private releaseProducer(): void {
    this.waitingProducers.shift()?.();
  }

  private releaseProducers(): void {
    while (this.waitingProducers.length > 0) {
      this.releaseProducer();
    }
  }
}
