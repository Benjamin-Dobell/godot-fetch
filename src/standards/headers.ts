import type { HeadersInit } from './types';

function normalizeHeaderName(value: string): string {
  return value.trim().toLowerCase();
}

const HEADER_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function assertByteString(value: string, kind: 'name' | 'value'): void {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0xff) {
      throw new TypeError(`Invalid header ${kind}`);
    }
  }
}

function assertValidHeaderName(name: string): void {
  const value = String(name);
  assertByteString(value, 'name');
  if (!HEADER_NAME_TOKEN.test(value)) {
    throw new TypeError('Invalid header name');
  }
}

function assertValidHeaderValue(value: string): void {
  const text = String(value);
  assertByteString(text, 'value');
  if (/[\u0000\u000A\u000D]/.test(text)) {
    throw new TypeError('Invalid header value');
  }
}

function assertValidResponseHeaderValue(value: string): void {
  const text = String(value);
  if (/[\u0000\u000A\u000D]/.test(text)) {
    throw new TypeError('Invalid header value');
  }
}

function normalizeHeaderValue(value: string, mode: 'response' | 'strict'): string {
  const text = String(value);
  if (mode === 'response') {
    return text;
  }
  return text.replace(/^[\t\r\n ]+|[\t\r\n ]+$/g, '');
}

export class Headers {
  private readonly map = new Map<string, { originalName: string; values: string[] }>();
  private readonly guard: 'none' | 'request';
  private readonly valueValidationMode: 'response' | 'strict';

  constructor(
    init?: HeadersInit,
    guard: 'none' | 'request' = 'none',
    valueValidationMode: 'response' | 'strict' = 'strict',
  ) {
    this.guard = guard;
    this.valueValidationMode = valueValidationMode;

    if (typeof init === 'undefined') {
      return;
    }

    if (init === null) {
      throw new TypeError('Invalid headers init');
    }

    const iteratorMethod = Reflect.get(init as object, Symbol.iterator);

    if (typeof iteratorMethod === 'function') {
      for (const pair of init as Iterable<unknown>) {
        if (!Array.isArray(pair) || pair.length !== 2) {
          throw new TypeError('Header pairs must be [name, value]');
        }

        const [name, value] = pair;
        this.append(String(name), String(value));
      }
      return;
    }

    if (typeof init !== 'object') {
      throw new TypeError('Invalid headers init');
    }

    for (const key of Reflect.ownKeys(init as object)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(init as object, key);

      if (!descriptor || !descriptor.enumerable) {
        continue;
      }

      if (typeof key === 'symbol') {
        throw new TypeError('Invalid header name');
      }

      const headerName = String(key);
      assertValidHeaderName(headerName);
      const value = Reflect.get(init as object, key);
      this.append(headerName, String(value));
    }
  }

  append(name: string, value: string): void {
    assertValidHeaderName(name);

    const headerValue = normalizeHeaderValue(value, this.valueValidationMode);

    if (this.valueValidationMode === 'response') {
      assertValidResponseHeaderValue(headerValue);
    } else {
      assertValidHeaderValue(headerValue);
    }

    if (!this.canSetHeader(name, value)) {
      return;
    }

    const originalName = String(name);
    const key = normalizeHeaderName(originalName);
    const existing = this.map.get(key);

    if (existing) {
      existing.values.push(headerValue);
      return;
    }

    this.map.set(key, { originalName, values: [headerValue] });
  }

  delete(name: string): void {
    assertValidHeaderName(name);
    this.map.delete(normalizeHeaderName(String(name)));
  }

  get(name: string): null | string {
    assertValidHeaderName(name);

    const entry = this.map.get(normalizeHeaderName(String(name)));

    if (!entry || entry.values.length === 0) {
      return null;
    }

    return entry.values.join(', ');
  }

  getSetCookie(): string[] {
    const entry = this.map.get('set-cookie');
    return entry ? [...entry.values] : [];
  }

  has(name: string): boolean {
    assertValidHeaderName(name);
    return this.map.has(normalizeHeaderName(String(name)));
  }

  set(name: string, value: string): void {
    assertValidHeaderName(name);

    const headerValue = normalizeHeaderValue(value, this.valueValidationMode);

    if (this.valueValidationMode === 'response') {
      assertValidResponseHeaderValue(headerValue);
    } else {
      assertValidHeaderValue(headerValue);
    }

    if (!this.canSetHeader(name, value)) {
      return;
    }

    const originalName = String(name);

    this.map.set(normalizeHeaderName(originalName), {
      originalName,
      values: [headerValue],
    });
  }

  forEach(callback: (value: string, key: string, parent: Headers) => void): void {
    for (const [, entry] of this.map.entries()) {
      callback(entry.values.join(', '), entry.originalName, this);
    }
  }

  *entries(): IterableIterator<[string, string]> {
    for (const [, entry] of this.map.entries()) {
      yield [entry.originalName, entry.values.join(', ')];
    }
  }

  *keys(): IterableIterator<string> {
    for (const [, entry] of this.map.entries()) {
      yield entry.originalName;
    }
  }

  *values(): IterableIterator<string> {
    for (const [, entry] of this.map.entries()) {
      yield entry.values.join(', ');
    }
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  private canSetHeader(name: string, value: string): boolean {
    if (this.guard !== 'request') {
      return true;
    }
    const normalized = normalizeHeaderName(String(name));
    if (normalized.startsWith('proxy-') || normalized.startsWith('sec-')) {
      return false;
    }
    if (FORBIDDEN_REQUEST_HEADERS.has(normalized)) {
      return false;
    }
    if (FORBIDDEN_METHOD_OVERRIDE_HEADERS.has(normalized) && containsForbiddenMethodToken(String(value))) {
      return false;
    }
    return true;
  }
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'access-control-request-private-network',
  'connection',
  'content-length',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

const FORBIDDEN_METHOD_OVERRIDE_HEADERS = new Set([
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
]);

function containsForbiddenMethodToken(value: string): boolean {
  return value
    .split(',')
    .map(token => token.trim().toUpperCase())
    .some(token => token === 'CONNECT' || token === 'TRACE' || token === 'TRACK');
}
