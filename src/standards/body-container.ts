import { PackedByteArray } from 'godot.lib.api';
import { createAbortError, normalizeAbortRejectionReason, type AbortSignal } from './abort';
import { Blob } from './blob';
import { copyBuffer, toBodyString, toUint8Array } from './body-utils';
import { TextDecoder } from './encoding';
import { ReadableStream, isReadableStreamLike, teeReadableStreamLike, type ReadableStreamLike } from './stream';
import type { BodyInit } from './types';

function makeSafeBytesResult(bytes: Uint8Array): { bytes: Uint8Array } {
  const result = Object.create(null) as { bytes: Uint8Array };
  result.bytes = bytes;
  return result;
}

export class BodyContainer {
  body: null | ReadableStream;
  bodyUsed: boolean;
  private readonly hasBody: boolean;
  private bodyBytes: null | Uint8Array;
  private readonly bodyText: null | string;
  private readonly resolveMimeType?: () => null | string;
  private readonly signal?: AbortSignal;

  constructor(body: null | BodyInit, signal?: AbortSignal, resolveMimeType?: () => null | string) {
    this.bodyUsed = false;
    this.signal = signal;
    this.resolveMimeType = resolveMimeType;

    if (body === null) {
      this.hasBody = false;
      this.body = null;
      this.bodyBytes = null;
      this.bodyText = null;
      return;
    }

    this.hasBody = true;

    if (isReadableStreamLike(body)) {
      this.body = body as ReadableStream;
      this.bodyBytes = null;
      this.bodyText = null;

      const streamBody = this.getStreamLike();

      if (streamBody === null) {
        throw new TypeError('ReadableStream body is unavailable');
      }

      if (this.signal) {
        this.signal.addEventListener('abort', () => {
          try {
            streamBody.cancel?.(normalizeAbortRejectionReason(this.signal?.reason));
          } catch {
            // Ignore cancellation propagation failures.
          }
        });
      }
      return;
    }

    const bytes = toUint8Array(body);
    this.bodyBytes = bytes;
    this.bodyText = toBodyString(body);
    this.body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.ensureReadable();
    this.bodyUsed = this.hasBody;
    this.markBufferedBodyConsumed();

    if (this.bodyBytes === null && this.body !== null) {
      this.bodyBytes = (await this.consumeStreamBytes()).bytes;
    }

    return this.bodyBytes ? copyBuffer(this.bodyBytes) : copyBuffer(new Uint8Array());
  }

  async text(): Promise<string> {
    this.ensureReadable();
    this.bodyUsed = this.hasBody;
    this.markBufferedBodyConsumed();

    if (this.bodyText === null && this.body !== null) {
      const streamed = (await this.consumeStreamBytes()).bytes;
      return new TextDecoder().decode(streamed);
    }

    return this.bodyText ?? '';
  }

  async blob(): Promise<Blob> {
    this.ensureReadable();
    this.bodyUsed = this.hasBody;
    this.markBufferedBodyConsumed();

    if (this.bodyBytes === null && this.body !== null) {
      this.bodyBytes = (await this.consumeStreamBytes()).bytes;
    }

    const mimeType = this.resolveMimeType?.() ?? '';
    return new Blob([this.bodyBytes ?? new Uint8Array()], { type: mimeType });
  }

  async bytes(): Promise<Uint8Array> {
    this.ensureReadable();
    this.bodyUsed = this.hasBody;
    this.markBufferedBodyConsumed();

    if (this.bodyBytes === null && this.body !== null) {
      this.bodyBytes = (await this.consumeStreamBytes()).bytes;
    }

    return this.bodyBytes ? this.bodyBytes.slice() : new Uint8Array();
  }

  cloneBody(): null | BodyInit {
    if (this.bodyBytes === null) {
      if (this.body === null) {
        return null;
      }

      const streamBody = this.getStreamLike();
      if (streamBody === null) {
        return null;
      }

      if ((streamBody.isLocked?.() ?? false) || (streamBody.isDisturbed?.() ?? false)) {
        throw new TypeError('Cannot clone an unreadable stream body');
      }

      const teed = teeReadableStreamLike(streamBody);
      this.body = teed.branch1;
      return teed.branch2;
    }
    return this.bodyBytes.slice(0);
  }

  cloneBodyForRequestTransfer(): null | BodyInit {
    if (!this.hasBody) {
      return null;
    }

    if (this.isBodyUsed()) {
      throw new TypeError('Cannot clone an unreadable stream body');
    }

    if (this.bodyBytes === null) {
      if (this.body === null) {
        return null;
      }

      const streamBody = this.getStreamLike();
      if (streamBody === null) {
        return null;
      }

      if ((streamBody.isLocked?.() ?? false) || (streamBody.isDisturbed?.() ?? false)) {
        throw new TypeError('Cannot clone an unreadable stream body');
      }

      const teed = teeReadableStreamLike(streamBody);
      this.bodyUsed = true;

      return teed.branch2;
    }

    this.bodyUsed = true;
    this.markBufferedBodyConsumed();
    return this.bodyBytes.slice(0);
  }

  markUsedForRequestInitOverride(): void {
    if (!this.hasBody) {
      return;
    }
    this.bodyUsed = true;
    this.markBufferedBodyConsumed();
  }

  isBodyUsed(): boolean {
    if (this.bodyUsed) {
      return true;
    }
    if (this.body === null) {
      return false;
    }
    return this.getStreamLike()?.isDisturbed?.() ?? false;
  }

  private markBufferedBodyConsumed(): void {
    if (!this.hasBody || this.body === null || this.bodyBytes === null) {
      return;
    }

    const streamBody = this.getStreamLike();
    if (streamBody === null) {
      return;
    }
    if ((streamBody.isLocked?.() ?? false) || (streamBody.isDisturbed?.() ?? false)) {
      return;
    }

    try {
      const reader = streamBody.getReader();
      void reader.read();
    } catch {
      // Ignore synthetic disturbance marker failures.
    }
  }

  private ensureReadable(): void {
    if (this.signal?.aborted) {
      throw normalizeAbortRejectionReason(this.signal.reason);
    }

    if (this.bodyUsed) {
      throw new TypeError('Body has already been consumed');
    }

    const streamBody = this.getStreamLike();

    if (streamBody !== null && (streamBody.isLocked?.() || streamBody.isDisturbed?.())) {
      throw new TypeError('Body stream is locked or disturbed');
    }
  }

  private getStreamLike(): null | ReadableStreamLike {
    if (this.body === null) {
      return null;
    }

    return this.body;
  }

  private async consumeStreamBytes(): Promise<{ bytes: Uint8Array }> {
    if (this.body === null) {
      return makeSafeBytesResult(new Uint8Array());
    }

    if (this.signal?.aborted) {
      throw normalizeAbortRejectionReason(this.signal.reason);
    }

    const reader = this.body.getReader();
    const chunks: Uint8Array[] = [];

    let total = 0;

    while (true) {
      const chunk = await this.readWithAbort(reader);

      if (chunk.done) {
        break;
      }

      const value = chunk.value;

      if (value instanceof Uint8Array) {
        chunks.push(value);
        total += value.byteLength;
        continue;
      }

      if (value instanceof PackedByteArray) {
        const bytes = new Uint8Array(value.to_array_buffer());
        chunks.push(bytes);
        total += bytes.byteLength;
        continue;
      }

      if (value instanceof ArrayBuffer) {
        throw new TypeError('ReadableStream request body chunks must be Uint8Array');
      }

      if (ArrayBuffer.isView(value)) {
        throw new TypeError('ReadableStream request body chunks must be Uint8Array');
      }

      throw new TypeError('ReadableStream request body chunks must be Uint8Array');
    }

    const merged = new Uint8Array(total);

    let offset = 0;

    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return makeSafeBytesResult(merged);
  }

  private async readWithAbort(reader: {
    cancel?: (reason?: unknown) => Promise<void>;
    read: () => Promise<{ done: boolean; value?: unknown }>;
  }): Promise<{ done: boolean; value?: unknown }> {
    const toSafeReadResult = (
      raw: { done: boolean; value?: unknown },
    ): { done: boolean; value?: unknown } => {
      const safe = Object.create(null) as { done: boolean; value?: unknown };
      safe.done = Boolean(raw.done);

      if ('value' in raw) {
        safe.value = raw.value;
      }

      return safe;
    };

    if (!this.signal) {
      const readResult = await reader.read();
      return toSafeReadResult(readResult);
    }

    if (this.signal.aborted) {
      const abortReason = normalizeAbortRejectionReason(this.signal.reason);
      void reader.cancel?.(abortReason);
      throw abortReason;
    }

    return await new Promise<{ done: boolean; value?: unknown }>((resolve, reject) => {
      let settled = false;

      const onAbort = () => {
        if (settled) {
          return;
        }

        settled = true;

        const abortReason = normalizeAbortRejectionReason(this.signal?.reason);

        void reader.cancel?.(abortReason);

        reject(abortReason);
      };

      this.signal?.addEventListener('abort', onAbort);
      reader.read()
        .then((value) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(toSafeReadResult(value));
        })
        .catch((error) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        })
        .finally(() => {
          this.signal?.removeEventListener('abort', onAbort);
        });
    });
  }
}
