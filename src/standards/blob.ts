import { TextDecoder, TextEncoder } from './encoding';

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function normalizeType(type: string): string {
  const normalized = type.toLowerCase();
  if (normalized.length === 0) return '';
  if (!normalized.includes('/')) return '';
  if (!/^[\x20-\x7E]+$/.test(normalized)) return '';
  return normalized;
}
export class Blob {
  readonly size: number;
  readonly type: string;
  private readonly data: Uint8Array;

  constructor(parts: any[] = [], options?: { type?: string }) {
    const chunks = parts.map((part) => {
      if (typeof part === 'string') {
        return new TextEncoder().encode(part);
      }

      if (part instanceof ArrayBuffer) {
        return new Uint8Array(part);
      }

      if (ArrayBuffer.isView(part)) {
        return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
      }

      if (part instanceof Blob) {
        return part.bytes();
      }

      if (part && typeof part.to_array_buffer === 'function') {
        return new Uint8Array(part.to_array_buffer());
      }

      return new TextEncoder().encode(String(part));
    });

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const buffer = new Uint8Array(total);

    let offset = 0;

    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    this.data = buffer;
    this.size = buffer.byteLength;
    this.type = options?.type ? normalizeType(options.type) : '';
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(copyBuffer(this.data));
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.data);
  }

  text(): string {
    return new TextDecoder().decode(this.data);
  }

  slice(start?: number, end?: number, contentType?: string): Blob {
    const size = this.size;
    const relativeStart = typeof start === 'number'
      ? (start < 0 ? Math.max(size + start, 0) : Math.min(start, size))
      : 0;
    const relativeEnd = typeof end === 'number'
      ? (end < 0 ? Math.max(size + end, 0) : Math.min(end, size))
      : size;
    const span = Math.max(relativeEnd - relativeStart, 0);
    const sliced = this.data.slice(relativeStart, relativeStart + span);

    return new Blob([sliced], { type: contentType ?? '' });
  }
}

