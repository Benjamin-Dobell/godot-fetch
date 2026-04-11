class SimpleReadableStreamDefaultController {
  constructor(private readonly stream: ReadableStream) {}

  close(): void {
    this.stream.close();
  }

  error(reason?: unknown): void {
    this.stream.error(reason);
  }

  enqueue(value: unknown): void {
    this.stream.enqueue(value);
  }
}

export class WritableStream {
  private closed = false;
  private readonly abortAlgorithm?: (reason?: unknown) => unknown | Promise<unknown>;
  private readonly closeAlgorithm?: () => unknown | Promise<unknown>;
  private readonly writeAlgorithm?: (chunk: unknown) => unknown | Promise<unknown>;

  constructor(sink?: {
    abort?: (reason?: unknown) => unknown | Promise<unknown>;
    close?: () => unknown | Promise<unknown>;
    write?: (chunk: unknown) => unknown | Promise<unknown>;
  }) {
    this.abortAlgorithm = sink?.abort;
    this.closeAlgorithm = sink?.close;
    this.writeAlgorithm = sink?.write;
  }

  async abort(reason?: unknown): Promise<void> {
    this.closed = true;
    await this.abortAlgorithm?.(reason);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.closeAlgorithm?.();
  }

  async write(chunk: unknown): Promise<void> {
    if (this.closed) {
      throw new TypeError('Cannot write to a closed stream');
    }
    await this.writeAlgorithm?.(chunk);
  }
}

export type ReadableStreamReaderLike = {
  cancel?: (reason?: unknown) => Promise<void>;
  read: (view?: Uint8Array) => Promise<{ done: boolean; value?: unknown }>;
  releaseLock?: () => void;
};

export type ReadableStreamLike = {
  cancel?: (reason?: unknown) => void;
  getReader: () => ReadableStreamReaderLike;
  isDisturbed?: () => boolean;
  isLocked?: () => boolean;
};

function makeReadResult(done: boolean, value?: unknown, hasValue = false): { done: boolean; value?: unknown } {
  const result = Object.create(null) as { done: boolean; value?: unknown };
  result.done = done;

  if (hasValue) {
    result.value = value;
  }

  return result;
}

export function isReadableStreamLike(value: unknown): value is ReadableStreamLike {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return typeof (value as { getReader?: unknown }).getReader === 'function';
}

function cloneStreamChunk(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }

  if (ArrayBuffer.isView(value)) {
    const sourceBytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const clonedBytes = new Uint8Array(sourceBytes.byteLength);
    clonedBytes.set(sourceBytes);
    const clonedBuffer = clonedBytes.buffer;

    if (value instanceof DataView) {
      return new DataView(clonedBuffer, 0, value.byteLength);
    }

    const constructor = value.constructor as {
      new (buffer: ArrayBuffer, byteOffset?: number, length?: number): unknown;
    };

    const typedArrayValue = value as unknown as { length?: number };

    if (typeof typedArrayValue.length !== 'number') {
      return new constructor(clonedBuffer, 0);
    }

    return new constructor(clonedBuffer, 0, typedArrayValue.length);
  }

  return value;
}

export function teeReadableStreamLike(source: ReadableStreamLike): {
  branch1: ReadableStream;
  branch2: ReadableStream;
} {
  const reader = source.getReader();
  let enqueue1: (value: unknown) => void = () => {};
  let close1: () => void = () => {};
  let error1: (reason?: unknown) => void = () => {};
  let enqueue2: (value: unknown) => void = () => {};
  let close2: () => void = () => {};
  let error2: (reason?: unknown) => void = () => {};
  let canceled1 = false;
  let canceled2 = false;
  let cancelledReason: unknown = undefined;

  const maybeCancelSource = () => {
    if (!canceled1 || !canceled2) {
      return;
    }

    void reader.cancel?.(cancelledReason);
  };

  const branch1 = new ReadableStream({
    cancel(reason?: unknown) {
      canceled1 = true;
      cancelledReason = reason;
      maybeCancelSource();
    },
    start(controller) {
      enqueue1 = controller.enqueue.bind(controller);
      close1 = controller.close.bind(controller);
      error1 = controller.error.bind(controller);
    },
  });

  const branch2 = new ReadableStream({
    cancel(reason?: unknown) {
      canceled2 = true;
      cancelledReason = reason;
      maybeCancelSource();
    },
    start(controller) {
      enqueue2 = controller.enqueue.bind(controller);
      close2 = controller.close.bind(controller);
      error2 = controller.error.bind(controller);
    },
  });

  void (async () => {
    try {
      while (true) {
        if (canceled1 && canceled2) {
          break;
        }

        const readResult = await reader.read();
        if (readResult.done) {
          close1();
          close2();
          break;
        }

        if (!canceled1) {
          enqueue1(readResult.value);
        }
        if (!canceled2) {
          enqueue2(cloneStreamChunk(readResult.value));
        }
      }
    } catch (error) {
      if (!canceled1) {
        error1(error);
      }
      if (!canceled2) {
        error2(error);
      }
    }
  })();

  return { branch1, branch2 };
}

class SimpleReadableStreamDefaultReader {
  readonly closed: Promise<void>;
  private readonly stream: ReadableStream;
  private released = false;

  constructor(stream: ReadableStream) {
    this.stream = stream;
    this.closed = this.stream.closedPromise();
  }

  read(_view?: Uint8Array): Promise<{ done: boolean; value?: unknown }> {
    if (this.released) {
      throw new TypeError('Cannot read from a released reader');
    }
    return this.stream.readChunk(_view);
  }

  releaseLock(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.stream.releaseReader();
  }

  cancel(reason?: unknown): Promise<void> {
    if (this.released) {
      return Promise.resolve();
    }
    this.released = true;
    this.stream.cancel(reason);
    return Promise.resolve();
  }
}

export class ReadableStream {
  private closed = false;
  private readonly controller: SimpleReadableStreamDefaultController;
  private errorValue: unknown = null;
  private readonly pull?: (controller: {
    close: () => void;
    enqueue: (value: unknown) => void;
    error: (reason?: unknown) => void;
  }) => void | Promise<void>;
  private readonly cancelAlgorithm?: (reason?: unknown) => void;
  private readonly queue: unknown[] = [];
  private readonly pendingReads: Array<{
    reject: (reason?: unknown) => void;
    resolve: (value: { done: boolean; value?: unknown }) => void;
  }> = [];
  private disturbed = false;
  private locked = false;
  private readonly streamClosedPromise: Promise<void>;
  private rejectClosed!: (reason?: unknown) => void;
  private resolveClosed!: () => void;

  constructor(source?: {
    cancel?: (reason?: unknown) => void;
    pull?: (controller: { close: () => void; enqueue: (value: unknown) => void; error: (reason?: unknown) => void }) => void | Promise<void>;
    start?: (controller: { close: () => void; enqueue: (value: unknown) => void; error: (reason?: unknown) => void }) => void;
  }) {
    this.streamClosedPromise = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    this.controller = new SimpleReadableStreamDefaultController(this);
    this.pull = source?.pull;
    this.cancelAlgorithm = source?.cancel;
    if (!source?.start) return;
    source.start(this.controller);
  }

  getReader(): {
    cancel: (reason?: unknown) => Promise<void>;
    closed: Promise<void>;
    read: (view?: Uint8Array) => Promise<{ done: boolean; value?: unknown }>;
    releaseLock: () => void;
  } {
    if (this.locked || this.disturbed) {
      throw new TypeError('ReadableStream is locked or disturbed');
    }
    this.locked = true;
    return new SimpleReadableStreamDefaultReader(this);
  }

  async pipeTo(destination: {
    abort?: (reason?: unknown) => unknown | Promise<unknown>;
    close?: () => unknown | Promise<unknown>;
    write?: (chunk: unknown) => unknown | Promise<unknown>;
  }): Promise<void> {
    const reader = this.getReader();

    try {
      while (true) {
        const readResult = await reader.read();
        if (readResult.done) {
          break;
        }
        if (typeof destination.write === 'function') {
          await destination.write(readResult.value);
        }
      }

      if (typeof destination.close === 'function') {
        await destination.close();
      }
    } catch (error) {
      if (typeof destination.abort === 'function') {
        try {
          await destination.abort(error);
        } catch {
          // Ignore destination abort errors and preserve original stream failure.
        }
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  isDisturbed(): boolean {
    return this.disturbed;
  }

  isLocked(): boolean {
    return this.locked;
  }

  closedPromise(): Promise<void> {
    return this.streamClosedPromise;
  }

  cancel(reason?: unknown): void {
    this.disturbed = true;
    this.cancelAlgorithm?.(reason);
    this.close();
  }

  close(): void {
    if (this.closed || this.errorValue !== null) return;
    this.closed = true;
    while (this.pendingReads.length > 0) {
      const pending = this.pendingReads.shift();
      pending?.resolve(makeReadResult(true));
    }
    this.resolveClosed();
  }

  error(reason?: unknown): void {
    if (this.closed || this.errorValue !== null) return;
    this.errorValue = reason ?? new TypeError('Stream errored');
    while (this.pendingReads.length > 0) {
      const pending = this.pendingReads.shift();
      pending?.reject(this.errorValue);
    }
    this.rejectClosed(this.errorValue);
  }

  enqueue(value: unknown): void {
    if (this.closed) {
      throw new TypeError('Cannot enqueue into a closed stream');
    }
    const pending = this.pendingReads.shift();
    if (pending) {
      pending.resolve(makeReadResult(false, value, true));
      return;
    }
    this.queue.push(value);
  }

  private applyReadView(
    value: unknown,
    view?: Uint8Array,
  ): { remainder: null | Uint8Array; value: unknown } {
    if (!view || !(value instanceof Uint8Array)) {
      return { remainder: null, value };
    }

    const copySize = Math.min(view.byteLength, value.byteLength);
    if (copySize > 0) {
      view.set(value.subarray(0, copySize));
    }

    const remainder = copySize < value.byteLength ? value.subarray(copySize) : null;
    return {
      remainder,
      value: view.subarray(0, copySize),
    };
  }

  async readChunk(view?: Uint8Array): Promise<{ done: boolean; value?: unknown }> {
    this.disturbed = true;
    if (this.queue.length > 0) {
      const queued = this.queue.shift();
      const normalized = this.applyReadView(queued, view);
      if (normalized.remainder) {
        this.queue.unshift(normalized.remainder);
      }
      return makeReadResult(false, normalized.value, true);
    }
    if (this.errorValue !== null) {
      const streamError = this.errorValue;
      if (typeof streamError === 'object' && streamError !== null) {
        throw streamError;
      }
      throw new TypeError(String(streamError));
    }
    if (this.pull) {
      await this.pull(this.controller);
      if (this.queue.length > 0) {
        const queued = this.queue.shift();
        const normalized = this.applyReadView(queued, view);
        if (normalized.remainder) {
          this.queue.unshift(normalized.remainder);
        }
        return makeReadResult(false, normalized.value, true);
      }
      if (this.errorValue !== null) {
        const streamError = this.errorValue;
        if (typeof streamError === 'object' && streamError !== null) {
          throw streamError;
        }
        throw new TypeError(String(streamError));
      }
    }
    if (this.closed) {
      return makeReadResult(true);
    }
    return await new Promise<{ done: boolean; value?: unknown }>((resolve, reject) => {
      this.pendingReads.push({ resolve, reject });
    });
  }

  releaseReader(): void {
    this.locked = false;
  }
}
