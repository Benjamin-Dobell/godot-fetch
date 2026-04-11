import { PackedByteArray, String as GodotString } from 'godot.lib.api';
import { getConformance } from '../conformance/index';

type BufferSourceLike = ArrayBuffer | ArrayBufferView;
function decodeUtf8Bytes(input: Uint8Array, fatal: boolean): string {
  const out: number[] = [];
  let index = 0;
  let codePoint = 0;
  let bytesNeeded = 0;
  let bytesSeen = 0;
  let lowerBoundary = 0x80;
  let upperBoundary = 0xBF;

  const pushReplacement = (): void => {
    if (fatal) {
      throw new TypeError('Invalid UTF-8 sequence');
    }

    out.push(0xFFFD);
  };

  const resetState = (): void => {
    codePoint = 0;
    bytesNeeded = 0;
    bytesSeen = 0;
    lowerBoundary = 0x80;
    upperBoundary = 0xBF;
  };

  while (index < input.length) {
    const byte = input[index]!;

    if (bytesNeeded === 0) {
      if (byte <= 0x7F) {
        out.push(byte);
        index += 1;
        continue;
      }

      if (byte >= 0xC2 && byte <= 0xDF) {
        bytesNeeded = 1;
        codePoint = byte & 0x1F;
        index += 1;
        continue;
      }

      if (byte >= 0xE0 && byte <= 0xEF) {
        bytesNeeded = 2;
        codePoint = byte & 0x0F;
        lowerBoundary = byte === 0xE0 ? 0xA0 : 0x80;
        upperBoundary = byte === 0xED ? 0x9F : 0xBF;
        index += 1;
        continue;
      }

      if (byte >= 0xF0 && byte <= 0xF4) {
        bytesNeeded = 3;
        codePoint = byte & 0x07;
        lowerBoundary = byte === 0xF0 ? 0x90 : 0x80;
        upperBoundary = byte === 0xF4 ? 0x8F : 0xBF;
        index += 1;
        continue;
      }

      pushReplacement();
      index += 1;
      continue;
    }

    if (byte < lowerBoundary || byte > upperBoundary) {
      pushReplacement();
      resetState();
      continue;
    }

    lowerBoundary = 0x80;
    upperBoundary = 0xBF;
    codePoint = (codePoint << 6) | (byte & 0x3F);
    bytesSeen += 1;
    index += 1;

    if (bytesSeen !== bytesNeeded) {
      continue;
    }

    out.push(codePoint);
    resetState();
  }

  if (bytesNeeded !== 0) {
    pushReplacement();
  }

  if (out.length === 0) {
    return '';
  }

  let result = '';
  const chunkSize = 0x4000;

  for (let offset = 0; offset < out.length; offset += chunkSize) {
    result += String.fromCodePoint(...out.slice(offset, offset + chunkSize));
  }

  return result;
}

function toPackedBytes(value: BufferSourceLike | PackedByteArray): PackedByteArray {
  if (value instanceof PackedByteArray) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new PackedByteArray(value);
  }

  if (ArrayBuffer.isView(value)) {
    if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
      return new PackedByteArray(value.buffer as ArrayBuffer);
    }

    return new PackedByteArray(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer);
  }

  return new PackedByteArray();
}

export class TextEncoder {
  readonly encoding = 'utf-8';

  encode(input = ''): Uint8Array {
    const packed = GodotString.to_utf8_buffer(input);
    return new Uint8Array(packed.to_array_buffer());
  }

  encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
    const encoded = this.encode(source);

    if (destination.byteLength === 0) {
      return { read: 0, written: 0 };
    }

    if (encoded.byteLength <= destination.byteLength) {
      destination.set(encoded, 0);

      return {
        read: source.length,
        written: encoded.byteLength,
      };
    }

    let consumedUnits = 0;
    let consumedBytes = 0;

    while (consumedUnits < source.length) {
      const codePoint = source.codePointAt(consumedUnits);

      if (typeof codePoint === 'undefined') {
        break;
      }

      const utf8Width = codePoint <= 0x7F
        ? 1
        : (codePoint <= 0x7FF ? 2 : (codePoint <= 0xFFFF ? 3 : 4));

      if (consumedBytes + utf8Width > destination.byteLength) {
        break;
      }

      consumedBytes += utf8Width;
      consumedUnits += codePoint > 0xFFFF ? 2 : 1;
    }

    if (consumedUnits === 0) {
      return { read: 0, written: 0 };
    }

    const prefix = this.encode(source.slice(0, consumedUnits));
    destination.set(prefix, 0);

    return {
      read: consumedUnits,
      written: prefix.byteLength,
    };
  }
}

export class TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  private bomHandled = false;
  private pendingBytes = new Uint8Array(0);

  constructor(label = 'utf-8', options?: { fatal?: boolean; ignoreBOM?: boolean }) {
    const normalized = label.toLowerCase();

    if (normalized !== 'utf-8' && normalized !== 'utf8') {
      throw new TypeError(`Unsupported encoding: ${label}`);
    }

    this.encoding = 'utf-8';
    this.fatal = Boolean(options?.fatal);
    this.ignoreBOM = Boolean(options?.ignoreBOM);
  }

  decode(input?: BufferSourceLike | PackedByteArray, options?: { stream?: boolean }): string {
    const stream = options?.stream === true;

    try {
      let bytes: Uint8Array;
      if (typeof input === 'undefined') {
        bytes = new Uint8Array(0);
      } else if (input instanceof PackedByteArray) {
        bytes = new Uint8Array(input.to_array_buffer());
      } else if (input instanceof ArrayBuffer) {
        bytes = new Uint8Array(input);
      } else if (ArrayBuffer.isView(input)) {
        bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      } else {
        bytes = new Uint8Array(0);
      }

      let combined = bytes;

      if (this.pendingBytes.byteLength > 0) {
        const merged = new Uint8Array(this.pendingBytes.byteLength + bytes.byteLength);
        merged.set(this.pendingBytes, 0);
        merged.set(bytes, this.pendingBytes.byteLength);
        combined = merged;
      }

      if (stream && combined.byteLength > 0) {
        const trailingIncompleteLength = this.getTrailingIncompleteLength(combined);

        if (trailingIncompleteLength > 0) {
          const splitAt = combined.byteLength - trailingIncompleteLength;
          this.pendingBytes = combined.slice(splitAt);
          combined = combined.slice(0, splitAt);
        } else {
          this.pendingBytes = new Uint8Array(0);
        }
      } else {
        this.pendingBytes = new Uint8Array(0);
      }

      const mode = getConformance().utf8Decoding;
      let output: string;

      if (!stream && !this.fatal && mode === 'fast') {
        output = toPackedBytes(combined).get_string_from_utf8();
      } else {
        output = decodeUtf8Bytes(combined, this.fatal);
      }

      if (!this.ignoreBOM && !this.bomHandled && output.length > 0) {
        this.bomHandled = true;
        if (output.charCodeAt(0) === 0xFEFF) {
          output = output.slice(1);
        }
      }

      return output;
    } catch (error) {
      if (this.fatal) {
        throw new TypeError(`Text decoding failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      return '';
    }
  }

  private getTrailingIncompleteLength(input: Uint8Array): number {
    if (input.byteLength === 0) {
      return 0;
    }

    const end = input.byteLength;
    let leadIndex = end - 1;
    let continuationCount = 0;

    while (leadIndex >= 0 && continuationCount < 3 && (input[leadIndex]! & 0xC0) === 0x80) {
      continuationCount += 1;
      leadIndex -= 1;
    }

    if (leadIndex < 0) {
      return 0;
    }

    const lead = input[leadIndex]!;
    const expectedLength = this.expectedUtf8Length(lead);

    if (expectedLength === 0) {
      return 0;
    }

    const availableLength = end - leadIndex;

    if (availableLength >= expectedLength) {
      return 0;
    }

    if (!this.isValidUtf8Prefix(input, leadIndex, availableLength, expectedLength)) {
      return 0;
    }

    return availableLength;
  }

  private expectedUtf8Length(lead: number): 0 | 2 | 3 | 4 {
    if (lead >= 0xC2 && lead <= 0xDF) return 2;
    if (lead >= 0xE0 && lead <= 0xEF) return 3;
    if (lead >= 0xF0 && lead <= 0xF4) return 4;
    return 0;
  }

  private isValidUtf8Prefix(input: Uint8Array, start: number, availableLength: number, expectedLength: number): boolean {
    const lead = input[start]!;
    const second = availableLength >= 2 ? input[start + 1]! : null;
    const third = availableLength >= 3 ? input[start + 2]! : null;

    if (availableLength >= 2) {
      if (second === null || (second & 0xC0) !== 0x80) {
        return false;
      }
      if (lead === 0xE0 && second < 0xA0) {
        return false;
      }
      if (lead === 0xED && second >= 0xA0) {
        return false;
      }
      if (lead === 0xF0 && second < 0x90) {
        return false;
      }
      if (lead === 0xF4 && second >= 0x90) {
        return false;
      }
    }

    if (availableLength >= 3) {
      if (third === null || (third & 0xC0) !== 0x80) {
        return false;
      }
    }

    return availableLength < expectedLength;
  }
}
