import { PackedByteArray } from 'godot.lib.api';
import { Blob } from './blob';
import { TextDecoder, TextEncoder } from './encoding';
import { FormData } from './form-data';
import { ReadableStream } from './stream';
import { URLSearchParams } from './url';
import type { BodyInit } from './types';
export function toUint8Array(value: BodyInit): Uint8Array {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }

  if (value instanceof URLSearchParams) {
    return new TextEncoder().encode(value.toString());
  }

  if (value instanceof FormData) {
    return new TextEncoder().encode(value.toMultipartBody());
  }

  if (value instanceof Blob) {
    return value.bytes();
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (value instanceof PackedByteArray) {
    return new Uint8Array(value.to_array_buffer());
  }

  if (value instanceof ReadableStream) {
    throw new TypeError('Streaming body byte conversion is not supported');
  }

  return new TextEncoder().encode(String(value));
}

export function toBodyString(value: BodyInit): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof URLSearchParams) {
    return value.toString();
  }

  if (value instanceof FormData) {
    return value.toMultipartBody();
  }

  if (value instanceof Blob) {
    return value.text();
  }

  if (value instanceof PackedByteArray) {
    return new TextDecoder().decode(value);
  }

  if (value instanceof ReadableStream) {
    throw new TypeError('Streaming body text decoding is not supported');
  }

  return new TextDecoder().decode(toUint8Array(value));
}
export function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
